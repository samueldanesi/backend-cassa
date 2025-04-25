const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAPI_KEY = '67fff535b6f89ac63306bb35'; // ✅ Chiave di PRODUZIONE Openapi

// 🔍 ROUTE DI TEST
app.get('/', (req, res) => {
  res.send('✅ Backend PRODUZIONE attivo e funzionante!');
});

// 🏢 CREAZIONE CONFIGURAZIONE AZIENDA
app.post('/api/crea-azienda', async (req, res) => {
  const dati = req.body;

  if (!dati.partitaIva || !dati.ragioneSociale || !dati.codiceFiscale || !dati.indirizzo) {
    return res.status(400).json({ errore: 'Tutti i campi fiscali sono obbligatori' });
  }

  try {
    const risposta = await axios.post(
      'https://invoice.openapi.it/IT-configurations', // ✅ Endpoint corretto
      {
        tax_id: dati.partitaIva,
        email: dati.email,
        company_name: dati.ragioneSociale,
        name: dati.ragioneSociale,
        contact_email: dati.email || 'no-reply@azienda.it',
        contact_phone: dati.telefono || '',
        fiscal_id: dati.codiceFiscale,
        address: dati.indirizzo,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAPI_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({ success: true, datiOpenapi: risposta.data });
  } catch (errore) {
    if (errore.response?.status === 409) {
      return res.status(200).json({ success: true, messaggio: 'Azienda già presente su Openapi' });
    }

    console.error('❌ Errore creazione azienda:', errore.response?.data || errore.message);
    res.status(500).json({ errore: 'Errore durante creazione azienda', dettaglio: errore.message });
  }
});

// 🧾 INVIO SCONTRINO
app.post('/api/invia-scontrino', async (req, res) => {
  const dati = req.body;

  if (
    !dati.partitaIva ||
    !Array.isArray(dati.prodotti) ||
    dati.prodotti.length === 0 ||
    !dati.totale ||
    !dati.data ||
    !dati.ora
  ) {
    return res.status(400).json({ errore: 'Dati dello scontrino mancanti o incompleti' });
  }

  try {
    const risposta = await axios.post(
     'https://invoice.openapi.it/IT-receipts', // ✅ Endpoint corretto
      {
        configuration_tax_id: dati.partitaIva,
        receipt_date: dati.data,
        receipt_time: dati.ora,
        items: dati.prodotti.map(p => ({
          description: p.nome,
          quantity: p.quantita,
          unit_price: p.prezzo,
          vat_rate: p.iva,
        })),
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