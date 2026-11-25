# OpenFlow — protocolo v1

Protocolo propio entre dos equipos con OpenFlow. **No** usa ni imita el protocolo de
Logi Options+ (puertos 59869–59871); solo se escuchan sus anuncios para mostrar, de forma
informativa, qué equipos tienen Options+ en la red.

## Modelo

El mouse **no** viaja por la red. Cuando el cursor toca el borde hacia el otro equipo, el
equipo que tiene el mouse le ordena por HID++ cambiar de canal (`CHANGE_HOST`) y avisa al
otro (`ENTER`) a qué altura del borde debe aparecer el cursor.

Cada equipo tiene `focus = here | there` (dónde está el cursor). Mientras el cursor está en
el equipo Linux, Windows bloquea su teclado con hooks de bajo nivel y reenvía las teclas
(`KEY`), que Linux escribe con un teclado virtual (uinput).

## HID++ (mouse)

Función `CHANGE_HOST` (0x1814), HID++ 2.0, reportes largos (0x11, 20 bytes):

| fn | nombre | respuesta / efecto |
|---|---|---|
| 0 | getHostInfo | `[nHosts, hostActual, …]` (hosts 0..2 = canales 1..3) |
| 1 | setCurrentHost(host) | el mouse se desconecta y se conecta al canal `host` |

- Por receptor Unifying/Bolt: colección usage page `0xFF00`, usage 2; índice de dispositivo 1..6.
- Por Bluetooth: usage page `0xFF43`, usage `0x0202`; índice `0xFF`.
- El índice de la función se obtiene con IRoot.getFeature(0x1814) y **se verifica** con
  IFeatureSet.getFeatureID: Solaar u Options+ pueden estar hablando con el mouse a la vez.
- Cada equipo averigua su propio canal leyendo `hostActual` cuando el mouse está conectado a él.

## Red

### Descubrimiento — UDP 59880 (broadcast cada 2 s, JSON en claro)

```json
{"app":"logi-flow-oss","v":1,"id":"<uuid>","name":"<hostname>","check":"<16 hex>"}
```

`check` = HMAC‑SHA256(llave, "key-check")[0:8]: dice si el código coincide sin revelarlo.
El equipo queda emparejado al recibir un `HELLO` autenticado.

### Mensajes — UDP 59881

```
"LF" | ver(1) | nonce(12) | AES-256-GCM(cuerpo) | tag(16)      AAD = 3 bytes de cabecera
cuerpo = tipo(u8) | sesión(u32) | seq(u32) | payload
```

Se descarta todo `seq` ≤ al último visto por sesión.
**Llave** = `scrypt(código, "logi-flow-oss/v1", N=2^15, r=8, p=1, 32 bytes)`.

| tipo | nombre | payload | notas |
|---|---|---|---|
| 1 | HELLO | JSON `{id, name}` | cada 1 s; 4 s sin HELLO = equipo perdido |
| 2 | ENTER | `edge u8, pos f32` | "el cursor pasa a ti" — **confiable** |
| 3 | LEAVE | `edge u8, pos f32` | "el cursor volvió a mí" — **confiable** |
| 7 | KEY | `code u16 (evdev), down u8` | "soltar" se envía 2 veces |
| 8 | RELEASE_ALL | — | soltar todas las teclas |
| 9 | CONFIG | JSON `{peerSide, at, host}` | disposición + canal del emisor; gana el `at` más reciente |
| 10 | ACK | `ref u32` | confirma el mensaje con ese `seq` |
| 11 | KEYSTATE | `n u8, code u16 × n` | teclas realmente presionadas, cada 300 ms mientras se reenvía el teclado |

(Los tipos 4–6 —MOVE, BUTTON, WHEEL— son de la versión que reenviaba el mouse por red; ya no se usan.)

**Confiable** = se reenvía cada 150 ms hasta recibir `ACK` (máx. 2.5 s).

**Teclas pegadas**: el receptor suelta toda tecla que no esté en el último `KEYSTATE`, y
todas si pasan 1.5 s sin `KEY`/`KEYSTATE`. El emisor considera soltada una tecla que lleve
1.2 s sin eventos (una tecla sostenida produce autorepetición).

Las teclas viajan como códigos evdev de Linux; Windows los traduce a/desde scan codes
(`keymap.js`), así que la distribución del teclado la aplica el equipo que escribe.

### Portapapeles y archivos — TCP 59882

Una conexión por transferencia, solo aceptada desde el equipo emparejado:

```
frame = u32 BE largo | nonce(12) | AES-256-GCM(contenido) | tag(16)      AAD = "LFC1"
1º frame: JSON {v:1, ts, rnd, kind:"clipboard", text?, html?, image:bool, files:[{rel,size}]}
          (se rechaza si ts tiene > 2 min o rnd ya se vio)
luego:    imagen PNG (1 frame) · archivos en frames ≤ 1 MiB, en orden
último:   JSON {done:true}
```

Se envía cuando el cursor deja un equipo (por el borde o porque el otro recuperó el mouse),
solo si el contenido cambió desde el último envío. Las rutas de archivos se sanean (sin
`..`, sin rutas absolutas) y se guardan en `Descargas/OpenFlow/<fecha>/`.

## Permisos

**Linux** (`build/linux/70-openflow.rules`, TAG `uaccess` = solo el usuario con sesión activa):

- `hidraw` de Logitech (USB y Bluetooth) → HID++.
- `input/event*` **solo de mouse Logitech** → saber cuándo el mouse vuelve con Easy‑Switch.
- `uinput` → colocar el cursor y escribir con el teclado remoto.

**Windows**: corre en la sesión del usuario (no necesita administrador). Los hooks de bajo
nivel los instala un ayudante en C# (`win-capture-helper.cs`) que se compila la primera vez
con el compilador incluido en Windows. Firewall: permitir OpenFlow en redes privadas.
