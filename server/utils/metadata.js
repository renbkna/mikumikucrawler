import sanitizeHtml from 'sanitize-html';

export function extractMetadata($) {
  const title = $('title').text().trim() || $('h1').first().text().trim() || '';

  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('p').first().text().trim().substring(0, 160) ||
    '';

  // Extract and sanitize main content
  const content = sanitizeHtml($('body').text(), {
    allowedTags: [],
    allowedAttributes: {},
  }).substring(0, 5000); // Limit content size

  return {
    title: title.substring(0, 200),
    description: description.substring(0, 500),
    content,
  };
}
