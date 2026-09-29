# FelipaCar · coche compartido La Felipa ⇄ Albacete

App web para que los vecinos de La Felipa compartan coche para ir y volver de Albacete. Quien conduce publica su viaje y los demás se apuntan. Se instala en el móvil como una app, con su propio icono, y **avisa con una notificación** cuando alguien publica un viaje.

## Qué hace

- Muestra los viajes en dos sentidos: **a Albacete** (recogida en la salida de La Felipa) y **a La Felipa** (recogida en la salida de Albacete).
- Quien conduce publica día, hora, plazas libres, punto de recogida y una nota opcional.
- Los vecinos se apuntan con su nombre y eligen **cuántas plazas** necesitan (por ejemplo, para ir con un hijo). Las plazas se descuentan y el coche nunca admite más de las indicadas, aunque dos personas reserven a la vez. Para cambiar el número de plazas, se anula la reserva («Ya no voy») y se vuelve a hacer.
- No hay ningún precio: quien quiera puede hacer una **donación voluntaria** a quien conduce para ayudar con la gasolina. La app solo lo recuerda con un texto.
- **Busco viaje:** si nadie ha publicado un viaje a su hora, un vecino puede dejar una petición (sentido, día, hora aproximada y plazas). Los conductores reciben un aviso y, al pulsar **«Yo te llevo»**, se publica su viaje con esa persona ya apuntada, que recibe un aviso. Cada vecino puede tener hasta 5 peticiones abiertas.
- **Avisos (notificaciones):**
  - Cada vecino recibe un aviso de cada viaje nuevo, y de cada petición de «Busco viaje», del sentido que elija.
  - Quien conduce recibe un aviso cuando alguien se apunta o se desapunta.
  - Los pasajeros reciben un aviso si se cancela el viaje.
- Se puede **instalar** en el móvil y abrir sin cobertura (verá la última copia guardada).
- Los viajes pasados desaparecen solos y los de días anteriores se borran automáticamente.

**Sin cuentas ni contraseñas.** Cada móvil recibe un identificador anónimo al abrir la app por primera vez. Eso permite que solo quien publica un viaje pueda cancelarlo. Solo se guarda el nombre que cada uno escribe. No se piden teléfonos ni correos.

## Cómo se instala en el móvil (para los vecinos)

- **Android (Chrome):** abrir la dirección de la app y pulsar «Instalar la app», o el menú ⋮ → «Instalar aplicación». Después, pulsar «Activar avisos».
- **iPhone (Safari, iOS 16.4 o posterior):** abrir la dirección en Safari, pulsar el botón de compartir y elegir «Añadir a pantalla de inicio». Después, abrir la app desde el nuevo icono y pulsar «Activar avisos». En iPhone los avisos **solo funcionan si la app está añadida a la pantalla de inicio**.

## Si los avisos aparecen bloqueados (sobre todo en Xiaomi)

Cuando el móvil bloquea los avisos, ninguna web puede volver a pedir permiso por sí sola: hay que permitirlos a mano en los ajustes. La app lo detecta y muestra el botón «Avisos bloqueados: ver cómo activarlos», con los pasos para Android (incluidos los ajustes de Xiaomi, Redmi y POCO: *Inicio automático* y *Ahorro de batería → Sin restricciones*), iPhone u ordenador. Si detecta el navegador propio de Xiaomi, recomienda usar Google Chrome. Al volver de los ajustes, la app comprueba sola el permiso y activa los avisos.

## Requisitos técnicos

- Node.js 22 (probado con 22.22).
- Dependencias fijadas en `package.json` y `package-lock.json`: Express 5.2.1, web-push 3.6.7 y @libsql/client 0.18.0.
- Base de datos: **Turso** (SQLite en la nube, plan gratuito) en producción. En tu ordenador, si no configuras Turso, se usa un archivo local en `DATA_DIR`.
- **HTTPS obligatorio** en producción: sin él, los móviles no permiten instalar la app ni recibir avisos. Vercel lo incluye.

## Configuración

Todas las opciones se pasan como variables de entorno (plantilla en `.env.example`).

| Variable | Para qué sirve | ¿Obligatoria? |
|---|---|---|
| `TURSO_DATABASE_URL` | Dirección de la base de datos Turso (empieza por `libsql://`) | Sí, en Vercel |
| `TURSO_AUTH_TOKEN` | Token de acceso a Turso (**secreto**) | Sí, en Vercel |
| `VAPID_SUBJECT` | Tu correo de contacto para los servicios de avisos, con formato `mailto:tu-correo@ejemplo.com` | Sí, para los avisos |
| `APP_TIMEZONE` | Zona horaria de los viajes | No (`Europe/Madrid`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves de los avisos | No |
| `PORT`, `DATA_DIR` | Solo para servidor propio o pruebas locales | No |

**Claves de los avisos:** no hace falta crearlas. La primera vez, el servidor las genera y las guarda en la propia base de datos, y las reutiliza siempre. Si se borrara la base de datos, los vecinos tendrían que volver a pulsar «Activar avisos». Si prefieres gestionarlas tú, genera un par con `npm run vapid` y guárdalas en las variables del servidor, nunca en GitHub.

## Despliegue gratuito en Vercel + Turso (recomendado)

1. **GitHub:** sube el proyecto a un repositorio. El `.gitignore` ya excluye `.env`, las bases de datos locales y `node_modules`.
2. **Turso:** en [turso.tech](https://turso.tech), crea una cuenta y una base de datos (por ejemplo, `felipa-albacete`, en una región de Europa). Copia su **URL** (`libsql://...`) y crea un **token** de acceso. Las tablas se crean solas al arrancar la app.
3. **Vercel:** en [vercel.com](https://vercel.com), entra con GitHub, pulsa **Add New → Project** e importa el repositorio. Vercel detecta Express solo; no cambies los ajustes de construcción.
4. Antes de pulsar **Deploy**, abre **Environment Variables** y añade `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` y `VAPID_SUBJECT`. Si ya lo habías desplegado, añádelas en **Settings → Environment Variables** y vuelve a desplegar (**Deployments → ⋯ → Redeploy**).
5. Comprueba que `https://tu-proyecto.vercel.app/healthz` responde `{"ok":true,"push":true}`.

En Vercel, la app funciona como una única función (`server.js` exporta la app de Express) y los archivos de `public/` se sirven desde su red de distribución. `vercel.json` solo ajusta la caché del service worker y del manifiesto.

## Probarlo en tu ordenador

```bash
npm install
cp .env.example .env      # pon tu correo en VAPID_SUBJECT si quieres probar avisos
node --env-file=.env server.js
```

Abre `http://localhost:3000`. Sin Turso configurado, los datos se guardan en `data/felipa.db`. En `localhost` los navegadores permiten probar los avisos sin HTTPS.

Pruebas automáticas:

```bash
npm test
```

## Otras formas de desplegarlo

El proyecto también funciona en cualquier servidor con Node.js 22 (`npm ci --omit=dev` y `node server.js`) o con Docker (`Dockerfile` y `docker-compose.yml`). Puede usar Turso o, si no se configura, un archivo local; en ese caso hace falta un **volumen persistente en `/data`**. El arranque del contenedor (`docker-entrypoint.sh`) ajusta solo los permisos del disco.

## Copias de seguridad

En Turso, el plan gratuito incluye restauración de hasta un día atrás. Como los viajes caducan cada día, lo importante que se guarda a largo plazo son las suscripciones a los avisos y sus claves. En instalación local, basta con copiar la carpeta `DATA_DIR`.

## Publicar una versión nueva

Si cambias los archivos de `public/`, sube el número de `CACHE` en `public/sw.js` (por ejemplo, de `felipa-v1` a `felipa-v2`) para que los móviles descarguen la versión nueva.

## Estructura

```
server.js                 Servidor: API, base de datos y envío de avisos
vercel.json               Ajustes de caché para Vercel
public/index.html         Página de la app
public/app.js             Lógica en el móvil (viajes, instalación, avisos)
public/styles.css         Estilos (modo claro y oscuro)
public/logo-deposito.jpg  Foto del depósito de agua usada como logo
public/sw.js              Service worker: instalación, uso sin cobertura y avisos
public/manifest.webmanifest  Nombre e iconos de la app instalada
public/icons/             Iconos
scripts/generate-vapid.js Genera claves de avisos (opcional)
docker-entrypoint.sh      Arranque del contenedor (permisos del disco)
test/api.test.js          Pruebas automáticas
```

## Sobre las donaciones voluntarias

Compartir coche entre particulares es legal en España mientras sea para **compartir gastos** y el conductor no obtenga beneficio. La app lo presenta como una ayuda voluntaria para la gasolina. Si el proyecto crece, conviene confirmarlo con un asesor.

## Pendiente o posibles mejoras

- Moderación: ahora cualquiera con el enlace puede publicar viajes. Si hubiera abusos, se podría añadir un código del pueblo o un panel de administración.
- Viajes recurrentes (por ejemplo, «todos los días laborables a las 7:30»).
- Recordatorio a los pasajeros 15 minutos antes de la salida.
