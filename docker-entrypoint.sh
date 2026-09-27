#!/bin/sh
# Algunos servicios (como Railway) montan el disco de datos como root.
# Ajustamos los permisos y arrancamos la app con un usuario sin privilegios.
set -e
mkdir -p "${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
