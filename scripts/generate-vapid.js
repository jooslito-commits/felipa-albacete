// Genera el par de claves VAPID que necesitan las notificaciones.
// Úsalo una sola vez y guarda las claves en el gestor de variables/secretos del servidor.
import webpush from "web-push";
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log("Copia estas dos líneas en las variables de entorno del servidor (no las subas a GitHub):\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
