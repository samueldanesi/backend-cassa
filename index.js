const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAPI_KEY = '6862a3b357c08077f206bb4c'; // ✅ Chiave di PRODUZIONE Openapi

// Elenco temporaneo di aziende disattivate (usa fiscal_id)
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

  next();
}

// ROUTE DI TEST
app.get('/', (req, res) => {
  res.send('✅ Backend PRODUZIONE attivo e funzionante!');
});

// CREAZIONE CONFIGURAZIONE AZIENDA
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


// INVIO SCONTRINO
app.post('/api/invia-scontrino', bloccaAziendeDisattivate, async (req, res) => {
  const dati = req.body;
  const codiceLotteria = dati.codice_lotteria || null;
  
  // ✅ RECUPERA IL CODICE DEL TICKET DALLA RICHIESTA
  const codiceTicket = dati.codiceTicket || null;

  if (
    !dati.partitaIva ||
    !Array.isArray(dati.prodotti) ||
    dati.prodotti.length === 0
  ) {
    return res.status(400).json({ errore: 'Dati dello scontrino mancanti o incompleti (nessun prodotto)' });
  }

  try {
    const prodottiFiltratiPerOpenAPI = dati.prodotti.filter(p => {
      // Filtra gli oggetti speciali usati dall'app (es. info ticket) e gli item a prezzo zero
      if (p.isTicketInfo === true) return false;
      const unitPrice = parseFloat(p.unit_price) || 0;
      if (unitPrice === 0) {
        console.log(`INFO: Articolo "${p.description}" con prezzo 0 filtrato, non verrà inviato a Openapi.`);
        return false;
      }
      return true;
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

    // ✅ MODIFICA: Usa direttamente i valori di pagamento inviati dall'app Flutter,
    // che ha già calcolato correttamente i pagamenti misti.
    let cash_payment_amount = dati.pagamentoContanti || 0;
    let electronic_payment_amount = dati.pagamentoCarta || 0;
    let ticket_restaurant_payment_amount = dati.pagamentoTicket || 0;
    let ticket_restaurant_quantity = dati.numeroTicket || 0;
    
    // La logica per i non riscossi rimane, basata sulla modalità di pagamento
    let goods_uncollected_amount = 0;
    let services_uncollected_amount = 0;
    if (dati.modalitaPagamento === 'Non riscosso - Beni') {
        goods_uncollected_amount = parseFloat(dati.totale) || 0;
    }
    if (dati.modalitaPagamento === 'Non riscosso - Servizi') {
        services_uncollected_amount = parseFloat(dati.totale) || 0;
    }


    // ✅ MODIFICA: COSTRUISCE L'ARRAY DEI TAG IN MODO DINAMICO
    const tagsDaInviare = [];
    if (codiceLotteria) {
      tagsDaInviare.push(`codice_lotteria:${codiceLotteria}`);
    }
    if (codiceTicket) {
      tagsDaInviare.push(`codice_ticket:${codiceTicket}`);
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
      invoice_issuing: false,
      tags: tagsDaInviare // Usa l'array aggiornato
    };
      
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

// ANNULLA SCONTRINO EMESSO
app.post('/api/elimina-scontrino', async (req, res) => {
  const { idOpenapi } = req.body;

  if (!idOpenapi) {
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

    res.status(200).json({ success: true, data: risposta.data });
  } catch (errore) {
    console.error('❌ Errore durante annullamento scontrino:', errore.response?.data || errore.message);
    res.status(500).json({
      errore: 'Errore durante annullamento scontrino',
      dettaglio: errore.response?.data || errore.message,
    });
  }
});

// Recupera configurazioni aziende da OpenAPI
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

// Ottieni tutti gli scontrini per una data azienda
app.get('/api/scontrini/:fiscal_id', async (req, res) => {
  const { fiscal_id } = req.params;

  try {
    const risposta = await axios.get(`https://test.invoice.openapi.com/IT-receipts`, {
      params: { fiscal_id },
      headers: {
        Authorization: `Bearer ${OPENAPI_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    res.status(200).json(risposta.data.data);
  } catch (errore) {
    console.error('❌ Errore recupero scontrini:', errore.response?.data || errore.message);
    res.status(500).json({
      errore: 'Errore nel recupero scontrini',
      dettaglio: errore.response?.data || errore.message,
    });
  }
});

// Ottieni dettagli azienda
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


// Disattiva scontrini
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

// Attiva scontrini
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


// AVVIO SERVER
app.listen(PORT, () => {
  console.log(`✅ Server PRODUZIONE avviato sulla porta ${PORT}`);
});
