import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../app/utils/escape_html.js';

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('neutralizes a script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Acme Inc')).toBe('Acme Inc');
  });
});
