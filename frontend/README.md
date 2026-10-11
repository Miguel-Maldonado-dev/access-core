# Interfaz del panel de control de acceso

Aplicación Next.js (exportación estática) que sirve el backend FastAPI de `panel_web/backend`. En la placa solo corre Python; Node.js se usa únicamente en la máquina de desarrollo.

- Pruebas: `npm test`
- Compilar: `npm run build` (genera el sitio estático en `out/`)
- Desarrollo: `NEXT_PUBLIC_API_BASE=http://localhost:8080 npm run dev`, con el backend iniciado con `CORS_ORIGINS=http://localhost:3000`

La instalación en la placa está en `panel_web/README.md`.
