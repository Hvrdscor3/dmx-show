# DMX Show — app de escritorio

## Probar en tu PC (sin instalar)
1. Instala Node.js LTS (nodejs.org).
2. En esta carpeta: `npm install` y luego `npm start`.

## Crear el instalador .exe en tu PC
`npm run dist` → queda en `dist/DMX Show Setup X.Y.Z.exe`.

## Actualización automática (GitHub)
1. Crea un repositorio PÚBLICO en GitHub llamado `dmx-show`.
2. En `package.json` cambia `TU_USUARIO_DE_GITHUB` por tu usuario.
3. Sube esta carpeta al repo.
4. Para publicar una versión:
   - Edita `app/index.html` (tu app).
   - Sube el número en `package.json` → "version": "1.0.1"
   - `git commit -am "v1.0.1"`  ·  `git tag v1.0.1`  ·  `git push --follow-tags`
5. GitHub compila el instalador solo (pestaña Actions, ~5 min) y lo publica en Releases.
6. Las PCs con DMX Show lo descargan en segundo plano al abrir la app y preguntan
   "Reiniciar ahora / Al cerrar la app". Nunca reinicia sola en pleno show.

La primera vez instala el .exe de Releases en cada PC; de ahí en adelante se actualiza sola.
