import sharp from "sharp";
import fs from "fs";
import path from "path";

async function main() {
  const rootLogo = path.resolve("logo.png");
  if (!fs.existsSync(rootLogo)) {
    throw new Error(`File logo.png not found at ${rootLogo}`);
  }

  console.log("Processing logo from:", rootLogo);
  const metadata = await sharp(rootLogo).metadata();
  console.log(`Dimensions: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);

  // 1. Destination in frontend/public/
  const destPublic = path.resolve("frontend/public/logo.png");
  fs.copyFileSync(rootLogo, destPublic);
  console.log("Copied to:", destPublic);

  // Also keep a copy at frontend/logo.png
  fs.copyFileSync(rootLogo, path.resolve("frontend/logo.png"));

  // 2. Generate icons with sharp
  const targets = [
    { file: "frontend/public/favicon-16.png", size: 16 },
    { file: "frontend/public/favicon-32.png", size: 32 },
    { file: "frontend/public/apple-touch-icon.png", size: 180 },
    { file: "frontend/public/icon-192.png", size: 192 },
    { file: "frontend/public/icon-512.png", size: 512 },
  ];

  for (const t of targets) {
    await sharp(rootLogo).resize(t.size, t.size).png().toFile(t.file);
    console.log(`Generated: ${t.file} (${t.size}x${t.size})`);
  }

  // Duplicate to frontend/ root folder
  fs.copyFileSync("frontend/public/favicon-16.png", "frontend/favicon-16.png");
  fs.copyFileSync("frontend/public/favicon-32.png", "frontend/favicon-32.png");
  fs.copyFileSync("frontend/public/apple-touch-icon.png", "frontend/apple-touch-icon.png");
  fs.copyFileSync("frontend/public/icon-192.png", "frontend/icon-192.png");
  fs.copyFileSync("frontend/public/icon-512.png", "frontend/icon-512.png");

  // Mirror to tyrian-site/
  fs.copyFileSync(rootLogo, "tyrian-site/logo.png");
  fs.copyFileSync("frontend/public/favicon-16.png", "tyrian-site/favicon-16.png");
  fs.copyFileSync("frontend/public/favicon-32.png", "tyrian-site/favicon-32.png");
  fs.copyFileSync("frontend/public/apple-touch-icon.png", "tyrian-site/apple-touch-icon.png");
  fs.copyFileSync("frontend/public/icon-192.png", "tyrian-site/icon-192.png");
  fs.copyFileSync("frontend/public/icon-512.png", "tyrian-site/icon-512.png");

  // Generate clean favicon.svg embedding the high-res logo as base64 data-uri
  const logoBuffer = await sharp(rootLogo).resize(128, 128).png().toBuffer();
  const b64 = logoBuffer.toString("base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <clipPath id="r">
    <rect width="64" height="64" rx="14" />
  </clipPath>
  <g clip-path="url(#r)">
    <image href="data:image/png;base64,${b64}" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
  </g>
</svg>
`;
  fs.writeFileSync("frontend/public/favicon.svg", svg);
  fs.writeFileSync("frontend/favicon.svg", svg);
  fs.writeFileSync("tyrian-site/favicon.svg", svg);
  console.log("Updated favicon.svg");

  // Update #mark in tyrian-site HTML files as template mirror
  const siteDir = path.resolve("tyrian-site");
  const htmlFiles = fs.readdirSync(siteDir).filter((f) => f.endsWith(".html"));
  const oldMarkRegex = /<symbol id="mark" viewBox="0 0 64 64">[\s\S]*?<\/symbol>/g;
  const newMark = `<symbol id="mark" viewBox="0 0 64 64"><clipPath id="mark-clip"><rect width="64" height="64" rx="14"/></clipPath><g clip-path="url(#mark-clip)"><image href="logo.png" width="64" height="64" preserveAspectRatio="xMidYMid meet"/></g></symbol>`;

  for (const f of htmlFiles) {
    const p = path.join(siteDir, f);
    let content = fs.readFileSync(p, "utf8");
    if (oldMarkRegex.test(content)) {
      content = content.replace(oldMarkRegex, newMark);
      fs.writeFileSync(p, content, "utf8");
      console.log(`Updated #mark in: ${f}`);
    }
  }

  console.log("Logo and icons processing complete!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
