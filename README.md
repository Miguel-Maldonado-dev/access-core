# access-core — Control de acceso

Sistema de control de acceso para fraccionamientos: una placa con ATmega328P lee tarjetas, teclados PIN, controles RF y botones de salida, y una Raspberry Pi u Orange Pi decide quién entra y acciona los relevadores.

## Estructura

| Carpeta | Qué contiene |
|---|---|
| `firmware/Firmware-Control-Acceso/` | Firmware del ATmega328P (Arduino Uno): 4 lectores Wiegand (tarjeta y teclado PIN), RF 433 MHz, 2 botones de salida y 4 relevadores |
| `firmware/Prueba_Relevadores/` | Sketch de prueba que activa A0–A3 uno por uno, para revisar la placa |
| `firmware/referencias/` | Sketches de referencia usados para el diseño (lector RF 433 MHz) |
| `panel/` | Panel de la placa: daemon UART + web local (FastAPI, SQLite y Next.js estático). Ver `panel/README.md` |
| `tools/tkinter/` | Herramientas de escritorio anteriores al panel web: administrador y simulador (Tkinter + SQLite) |
| `docs/protocolo/` | Protocolo UART entre el ATmega y el controlador (v2.2) |
| `docs/superpowers/` | Diseños (`specs/`) y planes de implementación (`plans/`) |
| `.claude/`, `.agents/`, `skills-lock.json` | Skills de Claude Code usadas en el desarrollo |

## Cómo arrancar cada parte

**Firmware:** abrir `firmware/Firmware-Control-Acceso/Firmware-Control-Acceso.ino` en Arduino IDE (placa Arduino Uno). Necesita la librería **rc-switch** 2.6.4 (Gestor de librerías: "rc-switch"). `Wiegand34` ya viene junto al sketch.

**Panel:** ver `panel/README.md` (desarrollo en Mac, paquete e instalación en la placa).

**Herramientas Tkinter:** `python3 tools/tkinter/access_control_admin_gui.py` (requiere `pyserial`). Cada script crea su base `access_control.sqlite` junto a él; git la ignora.

## Reglas del repositorio

- **Nunca se suben** bases SQLite, respaldos ni `.env`: contienen nombres de titulares, PIN en texto plano y contraseñas. El `.gitignore` los excluye.
- Los paquetes `.tar.gz` del panel se publican en **GitHub Releases**, no en el repositorio.
- `main` se mantiene estable; cada cambio va en su rama (`feat/...`, `fix/...`).
