import { readFileSync, writeFileSync } from 'fs'

let content = readFileSync('src/auth/add-account-remote.ts', 'utf8')
content = content.replace(
  "const CALLBACK_STYLE_HASH = 'kDGLhMkNwEVPPe78icWRKW/2YghmmnAY4xDhS2Imw8E='",
  "const CALLBACK_STYLE_HASH = createHash('sha256').update(CALLBACK_CSS).digest('base64')"
)
content = content.replace(
  "import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'",
  "import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'"
)
writeFileSync('src/auth/add-account-remote.ts', content)
