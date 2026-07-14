const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes free-text user input before interpolating it into an HTML email
 * template. Without this, any user-controlled string that ends up in an
 * email body (e.g. an org name set at signup) is a stored HTML-injection
 * vector against every real person that email gets sent to.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]);
