// Places the widget bundle at /widget.js (latest) and /widget/v1/widget.js (pinned major version).
import fs from "node:fs";
fs.mkdirSync("dist/widget/v1", { recursive: true });
fs.copyFileSync("dist-widget/widget.js", "dist/widget.js");
fs.copyFileSync("dist-widget/widget.js", "dist/widget/v1/widget.js");
console.log("widget copied to dist/widget.js and dist/widget/v1/widget.js");
