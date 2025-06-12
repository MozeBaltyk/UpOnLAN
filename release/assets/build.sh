#! /bin/bash
set -euo pipefail

# basic var setting
output_dir="../githubout"

# trigger build
trigger() {
  local asset="$1/setting.sh"
  if [ ! -f "$asset" ]; then
    echo "Asset file $asset does not exist. Skipping."
    return
  else
    echo "Processing $asset"
    source "${asset}"
    if [ -z "$OS" ] || [ -z "$VERSION" ] || [ -z "$ARCHS" ]; then
      echo "Required variables OS, VERSION, or ARCHS are not set in $asset. Skipping."
      return
    else
      # Add to endpoints.yml
      endpoints
      # Set the output directory based on OS and VERSION and ARCH
      IFS=',' read -ra ARCH_ARRAY <<< "$ARCHS"
      for ARCH in "${ARCH_ARRAY[@]}"; do
        build_dir="${output_dir}/${ARCH}/${OS}/${VERSION}/releases/${RELEASE}"
        mkdir -p "${build_dir}"
        build "${build_dir}"
      done
    fi
  fi
}

# build the output contents based on build type
build() {
  local build_dir="$1"
  if [ "${BUILD_TYPE}" == "iso_extraction" ]; then
    IFS=',' read -ra ARCH_ARRAY <<< "$ARCHS"
    for ARCH in "${ARCH_ARRAY[@]}"; do
      URL="${URL//REPLACE_ARCH/${ARCH}}"
      echo "Extracting from $URL"
      #curl -C - --retry 5 --retry-delay 5 --retry-connrefused -Lf -o "${build_dir}/$(basename "${URL}")" "${URL}" || { echo "Failed to download ${URL}"; exit 1; }
      iso_extraction "$build_dir"
    done
  elif [ "${BUILD_TYPE}" == "direct_file" ]; then
    echo "Building direct file download for ${OS} ${VERSION} (${ARCHS})"
    IFS=',' read -ra ARCH_ARRAY <<< "$ARCHS"   # parse once here
    while read -r DL; do
      for ARCH in "${ARCH_ARRAY[@]}"; do
        DLD="${DL//REPLACE_ARCH/$ARCH}"
        echo "Downloading: ${DLD}"
        URL="${DLD%|*}"
        OUT="${DLD#*|}"
        curl -C - --retry 5 --retry-delay 5 --retry-connrefused -Lf -o "${build_dir}/${OUT}" "${URL}" || { echo "Failed to download ${URL}"; exit 1; }
      done
    done <<< "${EXTRACTS}"
  fi
}

iso_extraction() {
  local build_dir="$1"
  # move files needed to build output
  while read -r MOVE; do
    SRC="${MOVE%|*}"
    DEST="${MOVE#*|}"
    SRC_BASE=$(basename "${SRC}")
    # Extract the source to destination
    find "${build_dir}" -name "*.iso" -exec 7z e {} ${SRC} -o"${build_dir}" -y \;
    # Rename as defined in the setting file
    if [ "${SRC_BASE}" != "${DEST}" ]; then
      mv "${build_dir}/${SRC_BASE}" "${build_dir}/${DEST}"
    fi
    # split this file if over 2 gigabytes
    filesize=$(stat -c %s "${build_dir}/${DEST}")
    echo -e "\n##########################\n"
    echo "${DEST}: ${filesize} bytes"
    echo -e "\n##########################\n"
    if [[ ${filesize} -gt 2097152000 ]]; then # 2Gb
      split -b 2097152000 "${build_dir}/${DEST}" "${build_dir}/${DEST}.part"
      mv "${build_dir}/${DEST}.partaa" "${build_dir}/${DEST}"
      mv "${build_dir}/${DEST}.partab" "${build_dir}/${DEST}.part2"
      if [[ -f "${build_dir}/${DEST}.partac" ]]; then
        mv "${build_dir}/${DEST}.partac" "${build_dir}/${DEST}.part3"
      fi
    fi
  done <<< "${EXTRACTS}"
  chmod 755 "${build_dir}"/*
  # clean up ISO files
  # rm -f "${build_dir}"/*.iso
}

### Not yet ready...
comnpress_initrd() {
  local build_dir="$1"
  # move files needed to build output
  while read -r MOVE; do
    DEST="${MOVE#*|}"
    mv /buildin/${DEST} /buildout/
    if [[ -f "/buildin/${DEST}.part2" ]]; then
      mv /buildin/${DEST}.part2 /buildout/
    fi
    if [[ -f "/buildin/${DEST}.part3" ]]; then
      mv /buildin/${DEST}.part3 /buildout/
    fi
  done <<< "${EXTRACTS}"
  # compress initrd folder into bootable file
  cd /buildin/initrd_files
  if [[ "${INITRD_TYPE}" == "xz" ]] || [[ "${INITRD_TYPE}" == "lz4" ]] ;then
    find . 2>/dev/null | cpio -o -H newc | xz --check=crc32 > /buildout/${INITRD_NAME}
  elif [[ "${INITRD_TYPE}" == "zstd" ]];then
    find . 2>/dev/null | cpio -o -H newc | zstd > /buildout/${INITRD_NAME}
  elif [[ "${INITRD_TYPE}" == "gz" ]];then
    find . | cpio -o -H newc | gzip -9 > /buildout/${INITRD_NAME}
  elif [[ "${INITRD_TYPE}" == "uncomp" ]];then
    find . | cpio -o -H newc > /buildout/${INITRD_NAME}
  elif [[ "${INITRD_TYPE}" == "arch-xz" ]];then
    find . -mindepth 1 -printf '%P\0' | sort -z | LANG=C bsdtar --null -cnf - -T - | LANG=C bsdtar --uid 0 --gid 0 --null -cf - --format=newc @- | xz --check=crc32 > /buildout/${INITRD_NAME}
  fi
  exit 0
}

endpoints(){
  TMP_YAML="${output_dir}/endpoints.yml"
  # Create TMP_YAML if it doesn't exist
  if [ ! -f "$TMP_YAML" ]; then
    echo "Creating endpoints YAML file at $TMP_YAML"
    echo "endpoints:" > "$TMP_YAML"
  fi
  IFS=',' read -ra ARCH_ARRAY <<< "$ARCHS"
  for ARCH in "${ARCH_ARRAY[@]}"; do
    KEY="${OS}-${VERSION}-${ARCH}"
    # Ensure the key exists in the YAML file
    yq e ".endpoints[\"${KEY}\"] = {}" -i "$TMP_YAML"
    # Safely write metadata with yq, all strings quoted
    yq e ".endpoints[\"${KEY}\"].path = \"/${ARCH}/${OS}/${VERSION}/releases/${RELEASE}\"" -i "$TMP_YAML"
    yq e ".endpoints[\"${KEY}\"].os = \"${OS}\"" -i "$TMP_YAML"
    yq e ".endpoints[\"${KEY}\"].version = \"${VERSION}\"" -i "$TMP_YAML"
    yq e ".endpoints[\"${KEY}\"].arch = \"${ARCH}\"" -i "$TMP_YAML"
    # Extract filenames from EXTRACTS (right-hand side of '|')
    yq e ".endpoints[\"$KEY\"].files = []" -i "$TMP_YAML"
    while IFS='|' read -r _ dst; do
      yq e ".endpoints[\"$KEY\"].files += [\"$dst\"]" -i "$TMP_YAML"
    done <<< "$EXTRACTS"
  done
}

if [ $# -ne 1 ]; then
  echo "Usage: $0 <asset_file>"
  exit 1
fi

asset="$1"
trigger "$asset"