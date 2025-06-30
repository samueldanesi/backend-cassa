const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAPI_KEY = '6862a3b357c08077f206bb4c'; // ✅ Chiave di PRODUZIONE Openapi

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


// 🧾 INVIO SCONTRINO (CON LOGICA items E PAGAMENTI MODIFICATA)
app.post('/api/invia-scontrino', bloccaAziendeDisattivate, async (req, res) => {
  const dati = req.body; // Dati inviati dal frontend Flutter
  const codiceLotteria = dati.codice_lotteria || null;
  // NUOVA: Ricevi la modalità di pagamento dal frontend
  const modalitaPagamentoFrontend = dati.modalitaPagamento;

  if (
    !dati.partitaIva ||
    !Array.isArray(dati.prodotti) ||
    dati.prodotti.length === 0
  ) {
    return res.status(400).json({ errore: 'Dati dello scontrino mancanti o incompleti (nessun prodotto)' });
  }

  try {
    // Filtra gli item: escludi quelli con unit_price === 0 (es. le note)
    const prodottiFiltratiPerOpenAPI = dati.prodotti.filter(p => {
      const unitPrice = parseFloat(p.unit_price) || 0;
      if (unitPrice === 0) {
        console.log(`INFO: Articolo "${p.description}" con prezzo 0 filtrato, non verrà inviato a Openapi.`);
        return false; // Escludi questo item
      }
      return true; // Mantieni questo item
    });

    if (dati.prodotti.length > 0 && prodottiFiltratiPerOpenAPI.length === 0) {
      console.warn('Attenzione: Tutti gli articoli sono stati filtrati (prezzo zero). Nessun item verrà inviato a Openapi.');
      return res.status(200).json({
        success: true,
        id: null,
        messaggio: 'Scontrino locale salvato. Nessun articolo inviabile a Openapi (solo note o item a prezzo zero).',
        dati: null
      });
    }

    // Mappa gli item filtrati per il payload di Openapi
    const itemsMappatiPerOpenAPI = prodottiFiltratiPerOpenAPI.map(p => {
      const itemData = {
        quantity: Number(p.quantity) || 1,
        description: p.description ?? '',
        unit_price: parseFloat(p.unit_price),
        vat_rate_code: p.vat_rate_code?.toString() ?? "22",
        complimentary: p.complimentary === true,
        sku: p.sku ?? ''
      };

      itemData.discount = parseFloat(p.discount) || 0;

      return itemData;
    });

    console.log("Items EFFETTIVAMENTE inviati a Openapi (dopo filtro):", JSON.stringify(itemsMappatiPerOpenAPI, null, 2));

    const totale = parseFloat(dati.totale) || 0;

    // Inizializza tutti gli importi a zero per poi popolarli condizionalmente
    let cash_payment_amount = 0;
    let electronic_payment_amount = 0;
    let ticket_restaurant_payment_amount = 0;
    let ticket_restaurant_quantity = 0;
    let goods_uncollected_amount = 0;
    let services_uncollected_amount = 0;
    let invoice_issuing = false; // Mantenuto a false, "Segue Fattura" non è più gestito

    // NUOVA LOGICA: Popola i campi di pagamento in base alla modalità ricevuta dal frontend
    switch (modalitaPagamentoFrontend) {
      case 'Contanti':
        cash_payment_amount = totale;
        break;
      case 'Elettronico':
        electronic_payment_amount = totale;
        break;
      case 'Non riscosso - Beni':
        goods_uncollected_amount = totale;
        break;
      case 'Non riscosso - Servizi':
        services_uncollected_amount = totale;
        break;
      default:
        // Fallback per modalità sconosciute o non gestite, logga un warning
        console.warn(`Modalità di pagamento sconosciuta o non gestita: ${modalitaPagamentoFrontend}. Nessun importo specifico impostato.`);
    }

    // Se il frontend ha inviato dati per ticket (es. per future implementazioni o test)
    if (dati.pagamentoTicket && parseFloat(dati.pagamentoTicket) > 0) {
        ticket_restaurant_payment_amount = parseFloat(dati.pagamentoTicket);
        ticket_restaurant_quantity = Number(dati.numeroTicket) || 1; // Default a 1 se l'importo c'è ma la quantità no
    }


    const payloadCompletoPerOpenAPI = {
      fiscal_id: dati.partitaIva,
      items: itemsMappatiPerOpenAPI,
      cash_payment_amount: parseFloat(cash_payment_amount.toFixed(2)),
      electronic_payment_amount: parseFloat(electronic_payment_amount.toFixed(2)),
      ticket_restaurant_payment_amount: parseFloat(ticket_restaurant_payment_amount.toFixed(2)),
      ticket_restaurant_quantity: ticket_restaurant_quantity,
      goods_uncollected_amount: parseFloat(goods_uncollected_amount.toFixed(2)),
      services_uncollected_amount: parseFloat(services_uncollected_amount.toFixed(2)),
      invoice_issuing: invoice_issuing, // Sarà sempre false
      tags: codiceLotteria ? [`codice_lotteria:${codiceLotteria}`] : []
    };
      
    // console.log("Payload COMPLETO inviato a Openapi:", JSON.stringify(payloadCompletoPerOpenAPI, null, 2));

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
    let messaggioDettaglio = errore.message; 
    if (errore.response?.data) {
        if (typeof errore.response.data === 'object' && errore.response.data !== null) {
            const openapiErrorData = errore.response.data;
            if (openapiErrorData.dettaglio && typeof openapiErrorData.dettaglio === 'object' && openapiErrorData.dettaglio !== null && openapiErrorData.dettaglio.message) {
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
