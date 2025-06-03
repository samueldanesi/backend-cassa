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
  const dati = req.body;
  const codiceLotteria = dati.codice_lotteria || null;

  if (
    !dati.partitaIva ||
    !Array.isArray(dati.prodotti) ||
    dati.prodotti.length === 0
  ) {
    return res.status(400).json({ errore: 'Dati dello scontrino mancanti o incompleti' });
  }

  try {
    const payloadPerOpenAPI = { // Costruiamo l'intero payload qui
      fiscal_id: dati.partitaIva,
      items: dati.prodotti.map(p => {
        // Definisci l'oggetto base per l'item
        const itemData = {
          quantity: p.quantity, // Assumiamo che Flutter invii un numero valido
          description: p.description ?? '', // Default a stringa vuota se mancante
          unit_price: parseFloat(p.unit_price) || 0, // Assicura sia un numero, default a 0
          vat_rate_code: p.vat_rate_code?.toString() ?? "22", // Default a "22" se mancante (Flutter dovrebbe fornirlo)
          complimentary: p.complimentary === true, // Converte a booleano stretto, default a false se mancante/null
          sku: p.sku ?? '' // Default a stringa vuota se mancante
        };

        // Aggiungi il campo 'discount' solo se è fornito dal frontend Flutter
        // ed è diverso da null. Se Flutter invia 'null' (es. per la nota a prezzo zero),
        // questo campo non verrà incluso nell'oggetto 'itemData' inviato a Openapi.
        if (p.discount !== null && p.discount !== undefined) {
          itemData.discount = parseFloat(p.discount); // Assicura sia un numero
        }
        // Altrimenti (se p.discount è null o undefined), il campo 'discount' non viene aggiunto a itemData.
        
        return itemData;
      }),
      cash_payment_amount: dati.pagamentoContanti ?? dati.totale,
      electronic_payment_amount: dati.pagamentoCarta ?? 0,
      ticket_restaurant_payment_amount: dati.pagamentoTicket ?? 0,
      ticket_restaurant_quantity: dati.numeroTicket ?? 0,
      goods_uncollected_amount: 0,
      services_uncollected_amount: 0,
      invoice_issuing: false,
      tags: codiceLotteria ? [`codice_lotteria:${codiceLotteria}`] : []
    };

    const risposta = await axios.post(
      'https://test.invoice.openapi.com/IT-receipts',
      payloadPerOpenAPI, // Usa il payload costruito
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
    console.error('❌ Errore invio scontrino:', errore.response?.data || errore.message);
    // Migliorata la gestione del messaggio di errore per includere dettagli dal backend Openapi
    const statusErrore = errore.response?.status || 500;
    let messaggioDettaglio = errore.message;
    if (errore.response?.data) {
        if (typeof errore.response.data === 'object' && errore.response.data !== null) {
            messaggioDettaglio = errore.response.data.message || errore.response.data.errore || JSON.stringify(errore.response.data);
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