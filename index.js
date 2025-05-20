const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAPI_KEY = '680a692f17e7399b1404f3fa'; // ✅ Chiave di PRODUZIONE Openapi

// 🔍 ROUTE DI TEST
app.get('/', (req, res) => {
  res.send('✅ Backend PRODUZIONE attivo e funzionante!');
});

// 🏢 CREAZIONE CONFIGURAZIONE AZIENDA
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

// 🧾 INVIO SCONTRINO (NUOVA VERSIONE CORRETTA)
app.post('/api/invia-scontrino', async (req, res) => {
  const dati = req.body;
  const codiceLotteria = dati.codice_lotteria || null; // ✅ AGGIUNTA

  if (
    !dati.partitaIva ||
    !Array.isArray(dati.prodotti) ||
    dati.prodotti.length === 0
  ) {
    return res.status(400).json({ errore: 'Dati dello scontrino mancanti o incompleti' });
  }

  try {
    const risposta = await axios.post(
      'https://test.invoice.openapi.com/IT-receipts',
      {
        fiscal_id: dati.partitaIva,
        items: dati.prodotti.map(p => ({
          quantity: p.quantity,
          description: p.description,
          unit_price: p.unit_price,
          vat_rate_code: p.vat_rate_code?.toString() ?? "22",
          discount: p.discount ?? 0,
          complimentary: p.complimentary ?? false,
          sku: p.sku ?? ''
        })),
        cash_payment_amount: dati.pagamentoContanti ?? dati.totale,
        electronic_payment_amount: dati.pagamentoCarta ?? 0,
        ticket_restaurant_payment_amount: dati.pagamentoTicket ?? 0,
        ticket_restaurant_quantity: dati.numeroTicket ?? 0,
        goods_uncollected_amount: 0,
        services_uncollected_amount: 0,
        invoice_issuing: false,
        tags: codiceLotteria ? [`codice_lotteria:${codiceLotteria}`] : [] // ✅ OPZIONALE
      },
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
    res.status(500).json({
      errore: 'Errore durante invio scontrino',
      dettaglio: errore.response?.data || errore.message,
    });
  }
})
// ❌ ANNULLA SCONTRINO EMESSO
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
  
      return res.status(200).json({ success: true, data: risposta.data });
    } catch (errore) {
      console.error('❌ Errore annullamento scontrino:', errore.response?.data || errore.message);
      return res.status(500).json({
        errore: 'Errore durante annullamento scontrino',
        dettaglio: errore.response?.data || errore.message,
      });
    }
  });
 // ✅ Recupera configurazioni aziende da OpenAPI
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
// ✅ Ottieni tutti gli scontrini per una data azienda
app.get('/api/scontrini/:fiscal_id', async (req, res) => {
  const fiscalId = req.params.fiscal_id;

  try {
    const risposta = await axios.get(
      `https://test.invoice.openapi.com/IT-receipts?fiscal_id=${fiscalId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    res.json(risposta.data.data);
  } catch (errore) {
    console.error('❌ Errore nel recupero scontrini:', errore.message);
    res.status(500).json({ errore: 'Errore nel recupero scontrini', dettaglio: errore.message });
  }
});
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
app.get('/api/azienda/:id', async (req, res) => {
  const id = req.params.id;
  try {
    console.log(`🔍 Richiesta dettagli per ID: ${id}`); // ✅ debug visibile da Render logs

    const risposta = await axios.get(
      `https://test.invoice.openapi.com/IT-configurations/${id}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json(risposta.data);
  } catch (e) {
    console.error('❌ Errore nei dettagli azienda:', e.response?.data || e.message); // ✅ log utile
    res.status(500).json({ 
      errore: 'Errore nei dettagli', 
      dettaglio: e.response?.data || e.message 
    });
  }
});
// 🚀 AVVIO SERVER
app.listen(PORT, () => {
  console.log(`✅ Server PRODUZIONE avviato sulla porta ${PORT}`);
});