# Adding the assistant to the Utilmo WordPress site

`utilmo.com` and `www.utilmo.com` are already in the allowed domains (Admin → Comportement & apparence → Domaines autorisés).
The assistant is served from `https://ai.utilmo.com` (Netlify). The old address `https://utilmo-ai-assistant.netlify.app` still works.

## Floating bubble on every page
Recommended: the free **WPCode** plugin (Insert Headers and Footers).
1. WordPress → Extensions → Ajouter → search **WPCode** → install and activate.
2. Code Snippets → **Header & Footer** → paste in **Footer**:
```html
<script src="https://ai.utilmo.com/widget.js" data-assistant-id="utilmo" data-mode="floating" defer></script>
```
3. Save. Open the site in a private window: the Utilmo bot appears bottom-right.

Alternative without a plugin (Elementor Pro): Elementor → Custom Code → Add new → location **</body> - End** → same script.

## Large chat inside a page (like the demo)
In the page (Gutenberg block **HTML personnalisé**, or Elementor widget **HTML**):
```html
<div id="utilmo-ai-chat"></div>
<script src="https://ai.utilmo.com/widget.js" data-assistant-id="utilmo" data-mode="inline" data-container="#utilmo-ai-chat" defer></script>
```
If the floating bubble is already in the footer, keep only the `<div>` and this line instead (same conversation in both):
```html
<div id="utilmo-ai-chat"></div>
<script>window.addEventListener("load",function(){window.UtilmoAI&&UtilmoAI.init({assistantId:"utilmo",inlineContainer:"#utilmo-ai-chat"});});</script>
```

## Tips
- Caching/optimisation plugins (WP Rocket, LiteSpeed, Autoptimize): exclude `widget.js` from "delay JavaScript"/"combine JS", otherwise the bubble appears late.
- Open the chat from a button: `<a href="#" onclick="UtilmoAI.open();return false;">Parler à notre assistant</a>`
- English pages: add `data-language="en"` to the script tag.
