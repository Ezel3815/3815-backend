import sanitizeHtml = require("sanitize-html");
// Cards store simple HTML (<b>, <i>, <u>, <br>, <span style="color:#...">). Everything else is removed.
export function cleanCardHtml(raw: string): string {
    return sanitizeHtml(raw ?? "", {
        allowedTags: ["b", "i", "u", "strong", "em", "br", "span", "div", "p", "sub", "sup", "ul", "ol", "li"],
        allowedAttributes: { "*": ["style"] },
        allowedStyles: { "*": { color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]+$/i], "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]+$/i] } },
    });
}
export function clozeCount(t: string): number { return (t.match(/\{\{c\d+::/g) || []).length; }
