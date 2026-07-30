// Vercel Serverless Function: /api/reviews
// Fetches Google Place Details (reviews + rating) and caches the response
// at the CDN edge so we call Google roughly once per cache window,
// not once per site visitor.
//
// Required environment variables (set in Vercel Project Settings -> Environment Variables):
//   GOOGLE_PLACES_API_KEY  - API key restricted to Places API + this domain
//   GOOGLE_PLACE_ID        - Place ID for the Gospel Detailing GBP listing

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    res.status(200).json({ configured: false, rating: null, total: 0, reviews: [] });
    return;
  }

  try {
    const url = `https://places.googleapis.com/v1/places/${placeId}`;
    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'rating,userRatingCount,reviews,googleMapsUri',
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
      rating: data.rating || null,
      total: data.userRatingCount || 0,
      mapsUrl: data.googleMapsUri || null,
      reviews,
    });
  } catch (err) {
    res.status(200).json({ configured: true, error: true, detail: String(err), rating: null, total: 0, reviews: [] });
  }
}
