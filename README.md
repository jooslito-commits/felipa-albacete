# La Felipa ⇄ Albacete · coche compartido

App web para que los vecinos de La Felipa compartan coche para ir y volver de Albacete. Quien conduce publica su viaje y los demás se apuntan. Se instala en el móvil como una app, con su propio icono, y **avisa con una notificación** cuando alguien publica un viaje.

## Qué hace

- Muestra los viajes en dos sentidos: **a Albacete** (recogida en la salida de La Felipa) y **a La Felipa** (recogida en la salida de Albacete).
- Quien conduce publica día, hora, plazas libres, punto de recogida y una nota opcional.
- Los vecinos se apuntan con su nombre. Las plazas se descuentan y el coche no admite más pasajeros de los indicados.
- Se recuerda la aportación voluntaria de **2 € por trayecto** para quien conduce.
- **Avisos (notificaciones):**
  - Cada vecino recibe un aviso de cada viaje nuevo del sentido que elija.
  - Quien conduce recibe un aviso cuando alguien se apunta o se desapunta.
  - Los pasajeros reciben un aviso si se cancela el viaje.
- Se puede **instalar** en el móvil y abrir sin cobertura (verá la última copia guardada).
- Los viajes pasados desaparecen solos y cada noche se borran los de días anteriores.

**Sin cuentas ni contraseñas.** Cada móvil recibe un identificador anónimo al abrir la app por primera vez. Eso permite que solo quien publica un viaje pueda cancelarlo. Solo se guarda el nombre que cada uno escribe. No se piden teléfonos ni correos.

## Cómo se instala en el móvil (para los vecinos)

- **Android (Chrome):** abrir la dirección de la app y pulsar «Instalar la app», o el menú ⋮ → «Instalar aplicación». Después, pulsar «Activar avisos».
- **iPhone (Safari, iOS 16.4 o posterior):** abrir la dirección en Safari, pulsar el botón de compartir y elegir «Añadir a pantalla de inicio». Después, abrir la app desde el nuevo icono y pulsar «Activar avisos». En iPhone los avisos **solo funcionan si la app está añadida a la pantalla de inicio**.

## Requisitos técnicos

- Node.js 22 (probado con 22.22).
- Las dependencias están fijadas en `package.json` y `package-lock.json`: Express 5.2.1, web-push 3.6.7 y better-sqlite3 13.0.3.
- Los datos se guardan en un archivo SQLite dentro de la carpeta indicada en `DATA_DIR`. No necesita otra base de datos.
- **Es obligatorio usar HTTPS** en producción: sin él, los móviles no permiten instalar la app ni recibir avisos.

## Configuración

Todas las opciones se pasan como variables de entorno. En `.env.example` hay una plantilla.

| Variable | Para qué sirve | Ejemplo |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `DATA_DIR` | Carpeta donde se guarda la base de datos | `/data` |
| `APP_TIMEZONE` | Zona horaria de los viajes | `Europe/Madrid` |
| `VAPID_PUBLIC_KEY` | Clave pública de los avisos | la genera `npm run vapid` |
| `VAPID_PRIVATE_KEY` | Clave privada de los avisos (**secreta**) | la genera `npm run vapid` |
| `VAPID_SUBJECT` | Correo de contacto para los servicios de avisos | `mailto:tu-correo@ejemplo.com` |

Las claves de los avisos se generan **una sola vez** y se guardan en el gestor de variables o secretos del servidor:

```bash
npm install
npm run vapid
```

No se deben subir a GitHub ni compartir por chat. Si se cambian más adelante, todos los vecinos tendrán que volver a pulsar «Activar avisos». Si faltan las claves, la app funciona igual pero sin avisos.

## Probarlo en tu ordenador

```bash
npm install
cp .env.example .env      # rellena las claves VAPID si quieres probar avisos
node --env-file=.env server.js
```

Abre `http://localhost:3000`. En `localhost` los navegadores permiten probar los avisos sin HTTPS.

Para ejecutar las pruebas automáticas:

```bash
npm test
```

## Despliegue con Docker (por ejemplo, en la plataforma Electropolis/Dokploy)

El proyecto incluye `Dockerfile` y `docker-compose.yml`.

1. Sube el proyecto a un repositorio de GitHub. El `.gitignore` ya excluye `.env`, la base de datos y `node_modules`.
2. Crea la aplicación en la plataforma a partir del repositorio, usando el `Dockerfile` o el `docker-compose.yml`.
3. Añade las variables `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` en el apartado de variables o secretos de la plataforma.
4. Monta un **volumen persistente en `/data`**. Si no, los viajes se pierden en cada actualización.
5. Asigna un dominio con **HTTPS** (por ejemplo, `felipa.tudominio.es`) apuntando al puerto 3000.
6. Comprueba que `https://tu-dominio/healthz` responde `{"ok":true}`.

Sin Docker basta con `npm ci --omit=dev` y `node server.js`, con las variables de entorno configuradas.

## Copias de seguridad

Todos los datos están en `DATA_DIR/felipa.db` (junto a los archivos `felipa.db-wal` y `felipa.db-shm`). Para hacer una copia, basta con guardar esa carpeta. Como los viajes caducan cada día, lo único que realmente se perdería son las suscripciones a los avisos: los vecinos tendrían que volver a activarlos.

## Publicar una versión nueva

Si cambias los archivos de `public/`, sube el número de `CACHE` en `public/sw.js` (por ejemplo, de `felipa-v1` a `felipa-v2`) para que los móviles descarguen la versión nueva.

## Estructura

```
server.js                 Servidor: API, base de datos y envío de avisos
public/index.html         Página de la app
public/app.js             Lógica en el móvil (viajes, instalación, avisos)
public/styles.css         Estilos (modo claro y oscuro)
public/sw.js              Service worker: instalación, uso sin cobertura y avisos
public/manifest.webmanifest  Nombre e iconos de la app instalada
public/icons/             Iconos
scripts/generate-vapid.js Genera las claves de los avisos
test/api.test.js          Pruebas automáticas
```

## Sobre la aportación de 2 €

Compartir coche entre particulares es legal en España mientras sea para **compartir gastos** y el conductor no obtenga beneficio. La app lo presenta como una ayuda voluntaria para la gasolina. Si el proyecto crece, conviene confirmarlo con un asesor.

## Pendiente o posibles mejoras

- Moderación: ahora cualquiera con el enlace puede publicar viajes. Si hubiera abusos, se podría añadir un código del pueblo o un panel de administración.
- Viajes recurrentes (por ejemplo, «todos los días laborables a las 7:30»).
- Recordatorio a los pasajeros 15 minutos antes de la salida.
