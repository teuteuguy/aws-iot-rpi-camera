#!/bin/bash

if [[ $EUID = 0 ]]; then
	echo "This script should not be run as sudo or root"
	exit 1
fi

cp cameraiot.service /lib/systemd/system/cameraiot.service
systemctl enable cameraiot.service
systemctl daemon-reload
systemctl start cameraiot.service
