// Vercel Serverless Function: /api/reviews
// Resolves the Gospel Detailing place by name/address via Places API Text
// Search (no manual Place ID hunting required), then fetches Place Details
// (reviews + rating). The whole result is cached at the CDN edge so we call
// Google roughly once per cache window, not once per site visitor.
//
// Required environment variable (Vercel Project Settings -> Environment Variables):
//   GOOGLE_PLACES_API_KEY  - API key restricted to Places API (New)
//
// Optional:
//   GOOGLE_PLACE_ID    - if you already have a confirmed valid Place ID
//                         (starts with "ChIJ"), set this to skip the text
//                         search step entirely.
//   GOOGLE_PLACE_QUERY - override the default search text below.

const DEFAULT_QUERY = 'Gospel Detailing LLC, McDonough, GA';

async function resolvePlaceId(apiKey) {
  const explicit = process.env.GOOGLE_PLACE_ID;
  if (explicit && explicit.startsWith('ChIJ')) return explicit;

  const query = process.env.GOOGLE_PLACE_QUERY || DEFAULT_QUERY;
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: 'US',
      languageCode: 'en',
      maxResultCount: 5,
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error('text search HTTP ' + response.status + ': ' + raw);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('text search returned non-JSON: ' + raw.slice(0, 300));
  }

  const place = data.places && data.places[0];
  if (!place) {
    throw new Error('text search returned no results for "' + query + '". Raw response: ' + raw.slice(0, 500));
  }
  return place.id;
}

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    res.status(200).json({ configured: false, rating: null, total: 0, reviews: [] });
    return;
  }

  try {
    const placeId = await resolvePlaceId(apiKey);

    const url = `https://places.googleapis.com/v1/places/${placeId}`;
    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'displayName,rating,userRatingCount,reviews,googleMapsUri',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(200).json({ configured: true, error: true, detail: errText, rating: null, total: 0, reviews: [] });
      return;
    }

    const data = await response.json();

    const reviews = (data.reviews || []).map((r) => ({
      author: r.authorAttribution?.displayName || 'Google User',
      photo: r.authorAttribution?.photoUri || null,
      rating: r.rating || null,
      text: r.text?.text || '',
      relativeTime: r.relativePublishTimeDescription || '',
      time: r.publishTime || null,
    }));

    // Cache at the edge for 6 hours; serve stale for up to 24h while revalidating.
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      configured: true,
      placeName: data.displayName?.text || null,
      rating: data.rating || null,
      total: data.userRatingCount || 0,
      mapsUrl: data.googleMapsUri || null,
      reviews,
    });
  } catch (err) {
    res.status(200).json({ configured: true, error: true, detail: String(err), rating: null, total: 0, reviews: [] });
  }
}
