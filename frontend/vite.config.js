import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const rootEnvPath = path.resolve(currentDir, '../.env')
const envDir = fs.existsSync(rootEnvPath) ? path.resolve(currentDir, '..') : currentDir

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir,
})


