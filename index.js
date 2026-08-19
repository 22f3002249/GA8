import express from 'express';
import { handleBuildCorpus } from './q1.js';
import { handleBqml } from './q2.js';
import { handlePromote } from './q3.js';

const app = express();
app.use(express.json());

// Adapter function to bridge Express req/res with Web Request/Response
async function adapt(handler, req, res) {
  try {
    const webRequest = new Request(`https://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : undefined
    });
    const webResponse = await handler(webRequest);
    const responseBody = await webResponse.text();
    res.status(webResponse.status);
    webResponse.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(responseBody);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}

app.post('/build-corpus', (req, res) => adapt(handleBuildCorpus, req, res));
app.post('/bqml', (req, res) => adapt(handleBqml, req, res));
app.post('/promote', (req, res) => adapt(handlePromote, req, res));

app.use((req, res) => res.status(404).send('Not Found'));

export default app;
