#!/bin/bash
set -eu

build () {
    sudo podman build -t localhost/uponlan:latest .
}

deploy () {
    build
    sudo podman play kube ./manifests/uponlan.yaml
}

destroy () { 
    sudo podman play kube --down ./manifests/uponlan.yaml 
    sudo podman rmi localhost/uponlan:latest
}

redeploy () {
    destroy
    deploy
}

logs () {
    sudo podman pod ps; echo ""
    sudo podman ps -a; echo ""
    sudo podman logs -f $(sudo podman ps -q)
}

connect () {
    sudo podman exec -it $(sudo podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}") /bin/sh
}

network () {
    sudo chmod +x ./scripts/display_networks_info.sh
    ./scripts/display_networks_info.sh
}

test () {
    read -p "Which pxe_config do you want to test? [uponlan]: " pxe_config
    network_name="uponlan"
    pxe_config=${pxe_config:-"uponlan"}
    sudo chmod +x ./scripts/create_kvm_test_network.sh
    sudo ./scripts/create_kvm_test_network.sh ${network_name} ${pxe_config}
    sudo chmod +x ./scripts/create_kvm_test_vm.sh
    sudo ./scripts/create_kvm_test_vm.sh ${network_name}
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
    echo "1. build - build uponlan image"
    echo "2. deploy - deploy uponlan container"
    echo "3. destroy - destroy uponlan container"
    echo "4. redeploy - redeploy uponlan container"
    echo "5. logs - display logs from uponlan container"
    echo "6. connect - connect to uponlan container"
    echo "7. test - pxeboot a VM on kvm domain"
    echo "8. network - check kvm/podman networks info"
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
    build) echo "Action: build uponlan image";;
    deploy) echo "Action: deploy uponlan container";;
    destroy) echo "Action: destroy uponlan container";;
    redeploy) echo "Action: redeploy uponlan container";;
    logs) echo "Action: display logs from uponlan container";;
    connect) echo "Action: connect to uponlan container";;
    test) echo "Action: test pxe boot with a kvm domain";;
    network) echo "Action: check kvm/podman networks info";;
    *) echo "Invalid action: $action"; print_help; exit 1;;
esac

exec_cmd