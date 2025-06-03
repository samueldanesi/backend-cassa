const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAPI_KEY = '6832e7b00af61204d2092f68'; // ✅ Chiave di PRODUZIONE Openapi

// Middleware (incluso per contesto, assicurati che aziendeDisattivate sia definito correttamente nel tuo ambiente)
// Elenco temporaneo di aziende disattivate (usa fiscal_id) - SPOSTA QUESTA DEFINIZIONE PIÙ IN ALTO O IN UN MODULO SEPARATO
const aziendeDisattivate = new Set([
  '04657834459', // esempio
  '12345678901'  // altro esempio
]);

function bloccaAziendeDisattivate(req, res, next) {
  const fiscalId = req.body.partitaIva;

  if (!fiscalId) {
    return res.status(400).json({ errore: 'Partita IVA mancante' });
  }

  if (aziendeDisattivate.has(fiscalId)) {
    return res.status(403).json({ errore: 'Azienda disattivata per morosità' });
  }

  next(); // altrimenti prosegui
}

// 🔍 ROUTE DI TEST (invariata)
app.get('/', (req, res) => {
  res.send('✅ Backend PRODUZIONE attivo e funzionante!');
});

// 🏢 CREAZIONE CONFIGURAZIONE AZIENDA (invariata)
app.post('/api/crea-azienda', async (req, res) => {
  const dati = req.body;

  if (
    !dati.partitaIva ||
    !dati.ragioneSociale ||
    !dati.codiceFiscale ||
    !dati.indirizzo ||
    !dati.usernameFisconline ||
    !dati.passwordFisconline ||
    !dati.pinFisconline
  ) {
    return res.status(400).json({ errore: 'Tutti i campi fiscali e le credenziali Fisconline + PIN sono obbligatori' });
  }

  try {
    const risposta = await axios.post(
      'https://test.invoice.openapi.com/IT-configurations',
      {
        fiscal_id: dati.partitaIva,
        name: dati.ragioneSociale,
        email: dati.email,
        receipts: true,
        receipts_authentication: {
          taxCode: dati.codiceFiscale,
          password: dati.passwordFisconline,
          pin: dati.pinFisconline,
        },
        api_configurations: [
          {
            event: 'receipt',
            callback: { url: 'https://backend-cassa.onrender.com/receipt' }
          },
          {
            event: 'receipt-error',
            callback: { url: 'https://backend-cassa.onrender.com/receipt-error' }
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({ 
      success: true, 
      company_id: risposta.data?.configuration_id || risposta.data?.tax_id || null, 
      datiOpenapi: risposta.data 
    });
  } catch (errore) {
    if (errore.response?.status === 409) {
      return res.status(200).json({ success: true, messaggio: 'Azienda già presente su Openapi' });
    }

    console.error('❌ Errore creazione azienda:', errore.response?.data || errore.message);
    res.status(500).json({ errore: 'Errore durante creazione azienda', dettaglio: errore.message });
  }
});


// 🧾 INVIO SCONTRINO (CON LOGICA items MODIFICATA)
 app.post('/api/invia-scontrino', bloccaAziendeDisattivate, async (req, res) => {
    const dati = req.body; // Dati inviati dal frontend Flutter
    const codiceLotteria = dati.codice_lotteria || null;

    if (
      !dati.partitaIva ||
      !Array.isArray(dati.prodotti) ||
      dati.prodotti.length === 0
    ) {
      return res.status(400).json({ errore: 'Dati dello scontrino mancanti o incompleti' });
    }

    try {
      const itemsPerOpenAPI = dati.prodotti.map(p => {
        // Definisci l'oggetto base per l'item da inviare a Openapi
        const itemData = {
          quantity: Number(p.quantity) || 1, // Assicura sia un numero, default a 1
          description: p.description ?? '',    // Default a stringa vuota se mancante
          unit_price: parseFloat(p.unit_price) || 0, // Assicura sia un numero, default a 0
          vat_rate_code: p.vat_rate_code?.toString() ?? "N4", // Default a "N4" (esente) se non fornito
                                                              // Il frontend Flutter dovrebbe inviare il codice corretto
          complimentary: p.complimentary === true, // Converte a booleano stretto, default a false
          sku: p.sku ?? '' // Default a stringa vuota se mancante
        };

        // Logica MODIFICATA per il campo 'discount':
        // Se unit_price è 0 (es. una Nota) E Flutter ha inviato discount: null,
        // NON includere il campo 'discount' nel payload per Openapi.
        // Altrimenti, includi il campo 'discount' con il valore fornito (o 0 se null/undefined e prezzo > 0).
        if (itemData.unit_price === 0 && (p.discount === null || p.discount === undefined)) {
          // Non fare nulla, il campo 'discount' non verrà aggiunto a itemData per questo item.
        } else {
          // Per articoli con prezzo > 0, o se discount è esplicitamente 0 per item a prezzo 0,
          // usa il discount fornito dal frontend (o default a 0).
          // Il frontend Flutter dovrebbe già aver applicato il workaround "prezzo - 0.01" per sconti 100% su item con prezzo.
          itemData.discount = parseFloat(p.discount) || 0;
        }
        
        return itemData;
      });

      // Log per debuggare il payload degli items inviato a Openapi
      console.log("Items inviati a Openapi:", JSON.stringify(itemsPerOpenAPI, null, 2));

      const payloadCompletoPerOpenAPI = {
        fiscal_id: dati.partitaIva,
        items: itemsPerOpenAPI,
        cash_payment_amount: parseFloat(dati.pagamentoContanti) || parseFloat(dati.totale) || 0, // Assicura sia numero
        electronic_payment_amount: parseFloat(dati.pagamentoCarta) || 0,  // Assicura sia numero
        ticket_restaurant_payment_amount: parseFloat(dati.pagamentoTicket) || 0, // Assicura sia numero
        ticket_restaurant_quantity: Number(dati.numeroTicket) || 0, // Assicura sia numero
        goods_uncollected_amount: 0, 
        services_uncollected_amount: 0,
        invoice_issuing: false,
        tags: codiceLotteria ? [`codice_lotteria:${codiceLotteria}`] : []
      };
      
      // Log per debuggare l'intero payload inviato a Openapi
      // console.log("Payload completo inviato a Openapi:", JSON.stringify(payloadCompletoPerOpenAPI, null, 2));


      const risposta = await axios.post(
        'https://test.invoice.openapi.com/IT-receipts',
        payloadCompletoPerOpenAPI,
        {
          headers: {
            Authorization: `Bearer ${OPENAPI_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('🧾 Risposta Openapi:', JSON.stringify(risposta.data, null, 2));
      res.status(200).json({ 
          success: true, 
          id: risposta.data?.data?.id ?? null, 
          dati: risposta.data 
        });
    } catch (errore) {
      console.error('❌ Errore invio scontrino a Openapi:', errore.response?.data || errore.message);
      const statusErrore = errore.response?.status || 500;
      let messaggioDettaglio = errore.message; // Fallback
      if (errore.response?.data) {
          if (typeof errore.response.data === 'object' && errore.response.data !== null) {
              // Tenta di estrarre il messaggio di errore specifico da Openapi
              const openapiErrorData = errore.response.data;
              if (openapiErrorData.dettaglio && openapiErrorData.dettaglio.message) {
                messaggioDettaglio = openapiErrorData.dettaglio.message;
              } else if (openapiErrorData.message) {
                messaggioDettaglio = openapiErrorData.message;
              } else if (openapiErrorData.errore) {
                messaggioDettaglio = openapiErrorData.errore;
              } else {
                messaggioDettaglio = JSON.stringify(openapiErrorData);
              }
          } else {
              messaggioDettaglio = errore.response.data.toString();
          }
      }
      res.status(statusErrore).json({
        errore: `Errore durante invio scontrino (Openapi status: ${statusErrore})`,
        dettaglio: messaggioDettaglio,
      });
    }
  });

  // Qui potresti avere altre route definite con app.get, app.post etc.
  // che hai omesso per brevità.


// Se questo è il tuo file server principale, avrai anche:
// const app = express();
// app.use(cors());
// app.use(express.json());
// require('./path/to/this/route/file')(app); // Se le route sono in file separati
// app.listen(PORT, () => {
//   console.log(`✅ Server PRODUZIONE avviato sulla porta ${PORT}`);
// });

// ❌ ANNULLA SCONTRINO EMESSO (invariata)
app.post('/api/elimina-scontrino', async (req, res) => {
  const { idOpenapi } = req.body;

  console.log('📥 Richiesta ricevuta per eliminare scontrino:', idOpenapi);

  if (!idOpenapi) {
    console.warn('⚠️ ID Openapi mancante nella richiesta.');
    return res.status(400).json({ errore: 'ID Openapi mancante' });
  }

  try {
    const risposta = await axios.delete(
      `https://test.invoice.openapi.com/IT-receipts/${idOpenapi}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅ Scontrino eliminato correttamente da OpenAPI:', risposta.data);

    return res.status(200).json({ success: true, data: risposta.data });
  } catch (errore) {
    console.error('❌ Errore durante annullamento scontrino:', errore.response?.data || errore.message);
    return res.status(500).json({
      errore: 'Errore durante annullamento scontrino',
      dettaglio: errore.response?.data || errore.message,
    });
  }
});

// ✅ Recupera configurazioni aziende da OpenAPI (invariata)
app.get('/api/utenti-configurati', async (req, res) => {
  try {
    const risposta = await axios.get(
      'https://test.invoice.openapi.com/IT-configurations',
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json(risposta.data.data);
  } catch (errore) {
    console.error('❌ Errore recupero configurazioni:', errore.response?.data || errore.message);
    res.status(500).json({
      errore: 'Errore nel recupero configurazioni',
      dettaglio: errore.response?.data || errore.message,
    });
  }
});

// ✅ Ottieni tutti gli scontrini per una data azienda (avevi due definizioni, ne tengo una)
app.get('/api/scontrini/:fiscal_id', async (req, res) => {
  const { fiscal_id } = req.params; // Usa destructuring coerentemente

  try {
    const risposta = await axios.get(`https://test.invoice.openapi.com/IT-receipts`, {
      params: { fiscal_id }, // Invia fiscal_id come query parameter
      headers: {
        Authorization: `Bearer ${OPENAPI_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    res.status(200).json(risposta.data.data); // OpenAPI di solito ha i dati in 'data.data' per le liste
  } catch (errore) {
    console.error('❌ Errore recupero scontrini:', errore.response?.data || errore.message);
    res.status(500).json({
      errore: 'Errore nel recupero scontrini',
      dettaglio: errore.response?.data || errore.message,
    });
  }
});

// ✅ Ottieni dettagli azienda (invariata)
app.get('/api/azienda/:fiscal_id', async (req, res) => {
  const fiscalId = req.params.fiscal_id;

  try {
    const risposta = await axios.get(
      `https://test.invoice.openapi.com/IT-configurations/${fiscalId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json(risposta.data);
  } catch (e) {
    console.error('❌ Errore nei dettagli azienda:', e.response?.data || e.message);
    res.status(500).json({
      errore: 'Errore nei dettagli',
      dettaglio: e.response?.data || e.message,
    });
  }
});


// ✅ Disattiva scontrini (invariata)
app.post('/api/disattiva-scontrini/:fiscal_id', async (req, res) => {
  const { fiscal_id } = req.params;

  try {
    const risposta = await axios.patch(
      `https://test.invoice.openapi.com/IT-configurations/${fiscal_id}`,
      { receipts: false }, 
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({ success: true, data: risposta.data });
  } catch (e) {
    console.error('❌ Errore disattivazione:', e.response?.data || e.message);
    res.status(500).json({
      errore: 'Errore disattivazione',
      dettaglio: e.response?.data || e.message,
    });
  }
});

// ✅ Attiva scontrini (invariata)
app.post('/api/attiva-scontrini/:fiscal_id', async (req, res) => {
  const fiscalId = req.params.fiscal_id;
  const { taxCode, password, pin } = req.body; 

  if (!taxCode || !password || !pin) {
    return res.status(400).json({ errore: 'Dati Fisconline mancanti' });
  }

  try {
    const risposta = await axios.patch(
      `https://test.invoice.openapi.com/IT-configurations/${fiscalId}`,
      {
        receipts: true,
        receipts_authentication: {
          taxCode,
          password,
          pin
        }
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return res.status(200).json({ success: true, message: 'Scontrini riattivati' });
  } catch (errore) {
    console.error('❌ Errore riattivazione:', errore.response?.data || errore.message);
    res.status(500).json({
      errore: 'Errore durante riattivazione',
      dettaglio: errore.response?.data || errore.message
    });
  }
});


// 🚀 AVVIO SERVER (invariato)
app.listen(PORT, () => {
  console.log(`✅ Server PRODUZIONE avviato sulla porta ${PORT}`);
});