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
          quantity: p.quantita,
          description: p.nome,
          unit_price: p.prezzo,
          vat_rate_code: p.iva?.toString() ?? "22", // Codice IVA come stringa
          discount: 0, // Aggiungi sconto per singolo prodotto se vuoi
          complimentary: false,
          sku: p.sku ?? ''
        })),
        cash_payment_amount: dati.pagamentoContanti ?? dati.totale,
        electronic_payment_amount: dati.pagamentoCarta ?? 0,
        ticket_restaurant_payment_amount: dati.pagamentoTicket ?? 0,
        ticket_restaurant_quantity: dati.numeroTicket ?? 0,
        goods_uncollected_amount: 0,
        services_uncollected_amount: 0,
        invoice_issuing: false,
        linked_receipt: '',
        discount: dati.scontoTotale ?? 0,
        lottery_code: '',
        tags: []
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({ success: true, dati: risposta.data });
  } catch (errore) {
    console.error('❌ Errore invio scontrino:', errore.response?.data || errore.message);
    res.status(500).json({
      errore: 'Errore durante invio scontrino',
      dettaglio: errore.response?.data || errore.message,
    });
  }
});

// 🚀 AVVIO SERVER
app.listen(PORT, () => {
  console.log(`✅ Server PRODUZIONE avviato sulla porta ${PORT}`);
});