#!/bin/bash
set -eu

build () {
    podman build -t localhost/uponlan:latest ./uponlan
}

deploy () {
    podman play kube ./manifests/uponlan.yaml --publish 8080:80 --publish 3000:3000 --publish 6969:69/udp
}

destroy () { 
    podman play kube --down ./manifests/uponlan.yaml 
    sudo rm -rf ./assets/*
    sudo rm -rf ./config/*
    podman rmi localhost/uponlan:latest
}

redeploy () {
    destroy
    deploy
}

logs () {
    podman pod ps; echo ""
    podman ps -a; echo ""
    podman logs -f $(podman ps -q)
}

connect () {
    podman exec -it $(podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}") /bin/sh
}

exec_cmd () {
    eval "${action}"
}

print_help () {
    echo ""
    echo "Usage: ./wakemeup.sh -a <action>"
    echo ""
    echo "Allowed Actions"
    echo "---------------"
    echo "1. build"
    echo "2. deploy"
    echo "3. destroy"
    echo "4. redeploy"
    echo "5. logs"
    echo "6. connect"
    echo ""
}

if [[ $# -ne 2 ]]
then
    print_help
    exit 1
fi

while getopts a: flag
do
    case "${flag}" in
        a) action=${OPTARG};;
    esac
done

case $action in
    build) echo "Action: build";;
    deploy) echo "Action: deploy";;
    destroy) echo "Action: destroy";;
    redeploy) echo "Action: redeploy";;
    logs) echo "Action: logs";;
    connect) echo "Action: connect";;
    *) echo "Invalid action: $action"; print_help; exit 1;;
esac

exec_cmd