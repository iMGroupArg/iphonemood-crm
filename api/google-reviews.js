// Trae rating y cantidad total de reseñas reales de Google Places para la
// landing (precios.html). La API Key vive en una variable de entorno del
// servidor — nunca llega al navegador — y la respuesta se cachea 7 días en
// el borde de Vercel (Cache-Control abajo), así que esta función solo le
// pega a Google ~1 vez por semana, sin necesidad de un cron aparte.
const PLACE_ID = process.env.GOOGLE_PLACE_ID;
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const { limitar } = require('./_ratelimit.js');

module.exports = async function handler(req, res) {
  // La respuesta se cachea 7 días en el CDN, así que esto protege solo el
  // cache miss — que es justo cuando la función le pega a Google con la
  // API key y cada request cuesta plata.
  if (!limitar(req, res, { max: 30, ventanaMs: 60_000 })) return;

  if (!PLACE_ID || !API_KEY) {
    console.error('Faltan las variables de entorno GOOGLE_PLACE_ID / GOOGLE_PLACES_API_KEY.');
    res.status(500).json({ error: 'Google Places no está configurado en el servidor.' });
    return;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(PLACE_ID)}&fields=rating,user_ratings_total&key=${API_KEY}`;
    const upstream = await fetch(url);
    const data = await upstream.json();

    if (data.status !== 'OK' || !data.result) {
      res.status(502).json({ error: 'Google Places no devolvió datos', detail: data.status });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=86400');
    res.status(200).json({
      rating: data.result.rating,
      total: data.result.user_ratings_total,
    });
  } catch (e) {
    res.status(502).json({ error: 'proxy error', detail: e.message });
  }
};
