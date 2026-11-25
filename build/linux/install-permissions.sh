#!/bin/sh
# OpenLogiFlow — permisos para usar la AppImage o el código fuente (el .deb ya lo hace solo).
#   sudo sh install-permissions.sh            instalar
#   sudo sh install-permissions.sh --remove   quitar
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(id -u)" -ne 0 ]; then echo "Ejecuta con sudo: sudo sh $0 $*"; exit 1; fi
if [ "$1" = "--remove" ]; then
  rm -f /etc/udev/rules.d/70-openlogiflow.rules /etc/modules-load.d/openlogiflow.conf
  udevadm control --reload-rules
  echo "Permisos de OpenLogiFlow quitados."
  exit 0
fi
install -m 0644 "$DIR/70-openlogiflow.rules" /etc/udev/rules.d/70-openlogiflow.rules
modprobe uinput 2>/dev/null || true
echo uinput > /etc/modules-load.d/openlogiflow.conf
udevadm control --reload-rules
udevadm trigger --subsystem-match=hidraw --subsystem-match=input --subsystem-match=misc
echo "Listo. Si el mouse estaba conectado, desconéctalo y vuelve a conectarlo (o cambia de canal)."
