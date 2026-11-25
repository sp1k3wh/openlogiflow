# OpenLogiFlow

**Usa un mouse Logitech —y el teclado de Windows— en dos equipos, Linux y Windows,
como lo hace Logi Options+ Flow.** Llevas el cursor al borde de la pantalla y el
mouse cambia solo de canal al otro equipo; el portapapeles y los archivos copiados
viajan con él.

> OpenLogiFlow es un proyecto independiente. **No está afiliado, respaldado ni
> patrocinado por Logitech.** "Logitech", "Logi Options+" y "Flow" son marcas de
> sus respectivos dueños. OpenLogiFlow no usa ni modifica Logi Options+: tiene su propio
> protocolo y habla con el mouse con comandos HID++ estándar.

## Qué hace

| Función | Cómo |
|---|---|
| **Cambio de equipo por el borde** | Al tocar el borde hacia el otro equipo, OpenLogiFlow le ordena al mouse (HID++ `CHANGE_HOST`) pasar al canal de ese equipo. El cursor aparece a la misma altura. El mouse **siempre se mueve en local**: nada del mouse viaja por la red, no hay lag. |
| **Teclado compartido** | Mientras el cursor está en el equipo Linux, el teclado del equipo Windows escribe allí. (El teclado de Linux no se comparte.) |
| **Portapapeles** | Texto, HTML e imágenes viajan con el cursor: copias en un equipo, pegas en el otro. |
| **Archivos** | Copias archivos o carpetas en el Explorador/Nautilus, pasas el cursor, pegas con Ctrl+V. Se guardan en `Descargas/OpenLogiFlow`. Límite: 2 GB por envío. |
| **Disposición** | Eliges en la app en qué lado está el otro equipo (izquierda, derecha, arriba, abajo). Se sincroniza sola. |
| **Easy-Switch a mano** | Si cambias de canal con el botón del mouse, los equipos lo notan y el teclado sigue al mouse. |
| **Equipo apagado** | Sin el otro equipo, Flow se desactiva solo y se reactiva cuando vuelve. |

Todo el tráfico entre equipos va **cifrado (AES‑256‑GCM)** con una llave derivada del
código de emparejamiento, y solo se acepta lo que viene del equipo emparejado.

## Requisitos

- **Un mouse Logitech con Easy‑Switch** (varios canales) y la función HID++
  `CHANGE_HOST` (0x1814): MX Anywhere 2S/3/3S, MX Master 2S/3/3S, MX Vertical, etc.
  Conectado por **receptor Unifying/Bolt o Bluetooth**, un canal por equipo.
- **Linux**: escritorio con X11 o Wayland (probado en Ubuntu con GNOME/Wayland), x86‑64.
- **Windows 10/11** x86‑64.
- Los dos equipos en la **misma red local**. Por cable o Wi‑Fi de 5 GHz funciona mejor.

## Instalación

Descarga los instaladores de la página de [Releases](../../releases).

### Linux (.deb — Ubuntu, Debian, Mint…)

```bash
sudo apt install ./openlogiflow_1.0.0_amd64.deb
```

El paquete instala los permisos necesarios (regla udev). Si el mouse ya estaba
conectado, cámbialo de canal o reconéctalo una vez.

### Linux (AppImage — otras distribuciones)

```bash
chmod +x OpenLogiFlow-1.0.0-x86_64.AppImage
./OpenLogiFlow-1.0.0-x86_64.AppImage
```

La AppImage no puede instalar permisos sola. Una vez, descarga
[`build/linux/`](build/linux) y ejecuta:

```bash
sudo sh install-permissions.sh
```

### Windows

Ejecuta `OpenLogiFlow-Setup-1.0.0.exe` (no necesita administrador). Como el instalador no
está firmado, Windows SmartScreen puede avisar: **Más información → Ejecutar de todas
formas**. La primera vez que abras OpenLogiFlow, Windows preguntará por el firewall:
permite el acceso en **redes privadas**.

> Si tu red está marcada como **Pública**, cámbiala a Privada
> (Configuración → Red e Internet → propiedades de la red) o OpenLogiFlow no podrá
> recibir conexiones.

## Configuración (una sola vez)

1. **Empareja los canales del mouse**: con el botón Easy‑Switch, empareja el canal 1, 2
   o 3 con cada equipo (Logi Options+, Solaar o el Bluetooth del sistema). Por ejemplo:
   canal 2 → Windows, canal 3 → Linux.
2. Abre OpenLogiFlow en los dos equipos → pestaña **Flow**.
3. En un equipo pulsa **Generar código**; escribe el **mismo código** en el otro y pulsa
   **Guardar** en los dos.
4. En **Disposición de pantallas**, haz clic donde está el otro equipo. Basta con hacerlo
   en uno: el otro se actualiza solo.
5. **Canal del mouse**: déjalo en *Automático* (OpenLogiFlow le pregunta al mouse en qué canal
   está cada equipo) o fíjalo a mano si hace falta.
6. En **Configuración**, activa **Iniciar OpenLogiFlow al iniciar sesión**.

Listo: lleva el cursor al borde.

### Atajos (en el teclado de Windows)

| Atajo | Acción |
|---|---|
| `Ctrl+Alt+→` (o la flecha hacia el otro equipo) | Pasar al otro equipo sin tocar el borde |
| `Ctrl+Alt+Esc` | Devolver el teclado a Windows |

## Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| "Flow en espera: no se encuentra el otro equipo" | Los dos con OpenLogiFlow abierto y el mismo código; firewall de Windows en red privada; misma red. |
| "Otro código de emparejamiento" | El código no es igual en los dos equipos. |
| El cursor no pasa al otro equipo | Pestaña Flow → *Canal del mouse*: el canal de cada equipo debe ser el correcto. En Linux, faltan permisos si la app lo avisa (ver instalación). |
| El mouse va al canal equivocado | Fija el canal a mano en *Canal del mouse*. |
| Una tecla quedó repitiéndose | Se suelta sola en menos de 1 s; si la red se corta, en 1.5 s. |
| Logs | Linux: `~/.config/OpenLogiFlow/logs/main.log` · Windows: `%APPDATA%\OpenLogiFlow\logs\main.log` |

Solaar (Linux) y Logi Options+ (Windows) pueden seguir instalados; OpenLogiFlow verifica cada
respuesta del mouse para no confundirse con las de ellos. Desactiva el *Flow* de Options+
para que no compitan.

## Desarrollo

```bash
git clone https://github.com/sp1k3wh/openlogiflow.git
cd openlogiflow
npm ci
npm start                      # ejecutar desde el código
npm run dist:linux             # → dist/*.deb y dist/*.AppImage
npm run dist:win               # → dist/OpenLogiFlow-Setup-*.exe (ejecutar en Windows)
```

Desde el código en Linux, instala los permisos con `sudo sh build/linux/install-permissions.sh`.

Al publicar un tag `v*`, GitHub Actions compila los instaladores de Linux y Windows y los
adjunta a un Release (ver `.github/workflows/release.yml`).

### Estructura

```
src/main/index.js                proceso principal (ventana, bandeja, IPC, inicio con la sesión)
src/main/flow-link/
  controller.js                  lógica de Flow (cambio de canal, teclado, portapapeles)
  hidpp.js                       HID++ 2.0: CHANGE_HOST por receptor o Bluetooth
  link.js, protocol.js           descubrimiento + canal UDP cifrado
  transfer.js, clipboard-sync.js portapapeles y archivos (TCP cifrado)
  edge-sensor.js                 Linux: sensor de 1 px en el borde (Wayland/X11)
  linux-capture.js, linux-inject.js   Linux: evdev (solo mouse Logitech) y uinput
  win-capture.js + .cs, win-inject.js Windows: hooks de bajo nivel y SendInput
src/renderer/                    interfaz
build/linux/                     regla udev y scripts del paquete .deb
docs/PROTOCOL.md                 protocolo de red
```

El protocolo está documentado en [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Licencia

[MIT](LICENSE)
