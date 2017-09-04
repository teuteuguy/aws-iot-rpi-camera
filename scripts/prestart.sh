#!/bin/bash
echo "Getting latest repo."
/usr/bin/git pull
echo "Running installation just in case"
/usr/local/bin/npm install
