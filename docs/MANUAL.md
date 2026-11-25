# Manual de uso de OpenLogiFlow

OpenLogiFlow te deja usar **un solo mouse Logitech en dos computadoras** —una con Linux y
otra con Windows— como si fueran una sola pantalla grande. Llevas el cursor al borde y
aparece en la otra computadora. El teclado de Windows, el portapapeles y los archivos
copiados lo siguen.

> OpenLogiFlow es un proyecto independiente: no está afiliado ni respaldado por Logitech.

---

## 1. Cómo funciona (en 30 segundos)

Tu mouse Logitech tiene un botón **Easy‑Switch** con 3 canales: cada canal puede estar
conectado a una computadora distinta. Normalmente cambias de computadora apretando ese
botón. OpenLogiFlow lo hace por ti:

1. Llevas el cursor al **borde** de la pantalla que da hacia la otra computadora.
2. OpenLogiFlow le ordena al mouse **cambiar de canal**.
3. El mouse se conecta a la otra computadora y el cursor aparece allá, **a la misma
   altura** por donde salió.

El mouse siempre se mueve "en local", conectado directamente a la computadora donde está
el cursor, así que **no hay lag**. Por la red solo viajan avisos, el teclado y el
portapapeles, todo cifrado.

---

## 2. Qué necesitas

- **Un mouse Logitech con Easy‑Switch** (varios canales). Funcionan, por ejemplo: MX
  Anywhere 2S / 3 / 3S, MX Master 2S / 3 / 3S, MX Vertical.
- Cada computadora conectada al mouse en **su propio canal**, por **receptor Unifying /
  Bolt** o por **Bluetooth**.
- Una computadora con **Linux** (Ubuntu, Debian, Mint, Fedora…) y otra con **Windows 10 u 11**.
- Las dos en la **misma red** (mismo router). Por cable o Wi‑Fi de 5 GHz va mejor.

---

## 3. Instalación

### 3.1 En Linux

**Ubuntu, Debian, Mint y derivados** — descarga `openlogiflow_X.Y.Z_amd64.deb` y en una
terminal:

```bash
sudo apt install ./openlogiflow_1.0.0_amd64.deb
```

**Otras distribuciones** — descarga `OpenLogiFlow-X.Y.Z-x86_64.AppImage`:

```bash
chmod +x OpenLogiFlow-1.0.0-x86_64.AppImage
./OpenLogiFlow-1.0.0-x86_64.AppImage
```

Con la AppImage, instala una vez los permisos (el .deb lo hace solo). Descarga la carpeta
`build/linux` del proyecto y ejecuta:

```bash
sudo sh install-permissions.sh
```

> Después de instalar, si el mouse ya estaba conectado, cámbialo de canal y vuelve (o
> desconéctalo y conéctalo) una vez para que tome los permisos.

### 3.2 En Windows

1. Ejecuta `OpenLogiFlow-Setup-X.Y.Z.exe`. No pide permisos de administrador.
2. Si aparece **"Windows protegió su PC"** (SmartScreen): pulsa **Más información →
   Ejecutar de todas formas**. Aparece porque el instalador no tiene firma digital.
3. Al abrir OpenLogiFlow por primera vez, Windows pregunta por el **firewall**: marca
   **Redes privadas** y pulsa **Permitir acceso**.
4. Revisa que tu red esté como **Privada**: *Configuración → Red e Internet → (tu red) →
   Tipo de perfil de red → Privada*. Si está como Pública, las computadoras no se verán.

---

## 4. Primera configuración

Hazlo una sola vez.

### Paso 1 — Conecta el mouse a las dos computadoras

Con el botón Easy‑Switch, elige un canal libre en cada computadora y emparéjalo
(Bluetooth del sistema, Logi Options+, Logi Bolt o Solaar). Ejemplo:

| Canal | Computadora |
|---|---|
| 1 | (libre) |
| 2 | Windows |
| 3 | Linux |

### Paso 2 — Abre OpenLogiFlow en las dos

En cada computadora, abre OpenLogiFlow y ve a la pestaña **Flow**.

### Paso 3 — Empareja con un código

1. En una computadora pulsa **Generar código**. Aparece un número de 6 dígitos.
2. En la otra, **escribe ese mismo número**.
3. Pulsa **Guardar** en las dos.

En segundos, la tarjeta de arriba dice **"Flow activo · Conectado con …"**, y en
*Computadoras en la Red* aparece la otra computadora como **Conectado**.

> Si dice **"Otro código de emparejamiento"**, los códigos no coinciden: vuelve a escribirlo.

### Paso 4 — Dile dónde está la otra pantalla

En **Disposición de pantallas** verás este equipo en el centro y cuatro casillas
alrededor. **Haz clic en el lado donde está físicamente la otra computadora**: por ejemplo,
si el Windows está a la izquierda de tu Linux, haz clic en *Izquierda*.

Basta con hacerlo en una computadora: la otra se actualiza sola, con el lado opuesto.

### Paso 5 — Revisa el canal del mouse

En **Canal del mouse** déjalo en **Automático**: OpenLogiFlow le pregunta al mouse en qué
canal está cada computadora. Abajo verás algo como *"usando canal 3 · DESKTOP‑XXXX: canal 2"*.

Si alguna vez el mouse salta al canal equivocado, elige el canal correcto a mano.

### Paso 6 — Que arranque solo

En la pestaña **Configuración**, activa **Iniciar OpenLogiFlow al iniciar sesión**. Así
arranca oculto en la bandeja del sistema cada vez que enciendes la computadora.

¡Listo! Lleva el cursor al borde y pruébalo.

---

## 5. Uso diario

### Pasar el cursor a la otra computadora

Lleva el cursor **hasta el borde** que elegiste en *Disposición*. En menos de un segundo
(1 a 3 s si es Bluetooth) el mouse se reconecta a la otra computadora y el cursor aparece
allá. Para volver, lleva el cursor al borde opuesto.

### El teclado

- El **teclado de la computadora con Windows** sigue al cursor: si el cursor está en
  Linux, lo que escribes en el teclado de Windows aparece en Linux.
- El teclado de la computadora con Linux (por ejemplo, el de una laptop) **no se
  comparte**: siempre escribe en Linux.

### Copiar y pegar

Copia como siempre (Ctrl+C), pasa el cursor a la otra computadora y pega (Ctrl+V).

- **Texto e imágenes** (por ejemplo, una captura de pantalla): se pegan directamente.
- **Archivos y carpetas**: cópialos en el Explorador de Windows o en el gestor de
  archivos de Linux, pasa el cursor y **pega en una carpeta** del otro equipo. Mientras se
  copian, la tarjeta de estado muestra el avance. Una copia queda además en
  **Descargas/OpenLogiFlow**, y aparece una notificación (haz clic en ella para abrir la carpeta).

> El portapapeles viaja **cuando el cursor cambia de computadora**. Si copias algo y no te
> mueves, no se envía nada. Límite de archivos: **2 GB** por envío.

### Si cambias de canal con el botón del mouse

También puedes seguir usando el botón Easy‑Switch: OpenLogiFlow nota en qué
computadora está el mouse y el teclado de Windows lo sigue.

### Atajos de teclado (en el teclado de Windows)

| Atajo | Qué hace |
|---|---|
| **Ctrl + Alt + flecha** hacia la otra computadora | Pasa el cursor sin llegar al borde |
| **Ctrl + Alt + Esc** | Devuelve el teclado a Windows |

### La bandeja del sistema

OpenLogiFlow vive en la bandeja (junto al reloj). Al pasar el cursor por su icono ves el
estado; con clic derecho tienes:

- **Abrir OpenLogiFlow**
- **Manual de uso**
- **Salir** (apaga Flow en esta computadora)

Cerrar la ventana **no** apaga Flow: sigue funcionando en la bandeja. Si prefieres que
cerrar la ventana cierre la app, desactiva *Al cerrar la ventana, seguir en la bandeja*
en Configuración.

---

## 6. Las opciones de la pestaña Flow

| Interruptor | Qué hace |
|---|---|
| **Cambio de Host** | Enciende o apaga Flow. Apagado, el borde no hace nada. |
| **Portapapeles** | Envía texto, HTML e imágenes al cambiar de computadora. |
| **Transferir Archivos** | Envía archivos y carpetas copiados. |
| **Teclado Compartido** | El teclado de Windows escribe en Linux cuando el cursor está allá. |

La tarjeta de arriba te dice siempre el estado:

| Mensaje | Significado |
|---|---|
| **Flow activo · Conectado con …** | Todo bien. También dice dónde está el cursor. |
| **Flow en espera** | No encuentra la otra computadora (apagada, sin la app o en otra red). |
| **Flow desactivado** | Apagaste *Cambio de Host*. |
| **Flow sin configurar** | Falta el código de emparejamiento. |

Si una computadora se apaga, Flow se desactiva solo y vuelve a activarse cuando la
computadora regresa. No tienes que hacer nada.

---

## 7. Solución de problemas

**"Flow en espera: no se encuentra el otro equipo"**
- ¿OpenLogiFlow está abierto en las dos? (Mira la bandeja.)
- ¿El mismo código en las dos?
- ¿Están en la misma red? ¿La red de Windows es **Privada**?
- En Windows: *Seguridad de Windows → Firewall → Permitir una aplicación* → OpenLogiFlow
  marcado en **Privada**.

**El cursor no pasa a la otra computadora**
- Revisa *Disposición de pantallas*: ¿elegiste el lado correcto?
- Revisa *Canal del mouse*: el canal de cada computadora debe ser el correcto.
- En Linux, si la app dice **"Faltan permisos"**, instala los permisos (sección 3.1).
- ¿Tienes **Logi Options+** en Windows con *Flow* activado? Desactiva su Flow.

**El mouse salta pero luego vuelve solo**
- Ocurre si el canal configurado para la otra computadora es incorrecto. Fija los canales
  a mano en *Canal del mouse*.

**El mouse tarda en conectarse (Bluetooth)**
- Por Bluetooth el mouse tarda 1–3 s en reconectarse; por receptor Unifying/Bolt, menos
  de 1 s. Si puedes, usa el receptor.

**Una tecla quedó repitiéndose**
- Se suelta sola en menos de un segundo. Si la red se cortó, en 1.5 s. Si te pasa seguido,
  la Wi‑Fi está perdiendo paquetes: prueba con cable o con la banda de 5 GHz.

**No puedo escribir en el Administrador de tareas u otra ventana "de administrador" en Windows**
- Es una limitación de Windows: una app normal no puede escribir en ventanas de
  administrador. Usa el teclado directamente en esa computadora.

**El icono no aparece en la barra de tareas (Linux)**
- Desancla el icono viejo de la barra y vuelve a anclar OpenLogiFlow desde el menú.

**¿Dónde están los registros (logs)?**
- Linux: `~/.config/OpenLogiFlow/logs/main.log`
- Windows: `%APPDATA%\OpenLogiFlow\logs\main.log`

---

## 8. Privacidad y seguridad

- Todo lo que viaja entre tus computadoras va **cifrado** (AES‑256‑GCM) con una llave que
  sale del código de emparejamiento. Sin ese código, nadie en la red puede leerlo ni
  hacerse pasar por tu computadora.
- OpenLogiFlow **no se conecta a internet** ni envía datos a nadie: solo habla con la otra
  computadora de tu red.
- En Linux solo pide permiso para el **mouse Logitech** y para crear un teclado/mouse
  virtual. **Nunca lee tu teclado de Linux.**
- Los archivos recibidos se guardan solo en tu carpeta *Descargas/OpenLogiFlow*.

---

## 9. Desinstalar

**Linux (.deb)**
```bash
sudo apt remove openlogiflow
```
Esto también quita los permisos. Si usaste la AppImage: borra el archivo y ejecuta
`sudo sh install-permissions.sh --remove`.

**Windows**: *Configuración → Aplicaciones → OpenLogiFlow → Desinstalar*.

Tu configuración queda en `~/.config/OpenLogiFlow` (Linux) o `%APPDATA%\OpenLogiFlow`
(Windows); bórrala si no piensas volver a usarla.

---

## 10. Preguntas frecuentes

**¿Funciona entre dos Windows o dos Linux?**
Está pensado y probado para Linux ↔ Windows. Entre dos Windows debería funcionar; entre dos
Linux funciona el cambio de canal, pero no se comparte el teclado.

**¿Puedo usar Logi Options+ o Solaar al mismo tiempo?**
Sí. Sirven para configurar botones o DPI. Solo desactiva el *Flow* de Options+.

**¿Necesito internet?**
No. Solo que las dos computadoras estén en la misma red local.

**¿Y si tengo dos pantallas en una computadora?**
OpenLogiFlow usa el borde exterior del conjunto de pantallas del lado que elijas.
