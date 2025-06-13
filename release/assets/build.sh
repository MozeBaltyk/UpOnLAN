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
      # Set the output directory based on OS and VERSION and ARCH
      IFS=',' read -ra ARCH_ARRAY <<< "$ARCHS"
      for ARCH in "${ARCH_ARRAY[@]}"; do
        if [ "${ARCH}" == "aarch64" ]; then
          GENERIC_ARCH="arm64"
        elif [ "${ARCH}" == "amd64" ]; then
          GENERIC_ARCH="x86_64"
        else
          GENERIC_ARCH="${ARCH}"
        fi
        build_dir="${output_dir}/${GENERIC_ARCH}/${OS}/${VERSION}/releases/${RELEASE}"
        mkdir -p "${build_dir}"
        build "${build_dir}"
        endpoints
      done
    fi
  fi
}

# build the output contents based on build type
build() {
  local build_dir="$1"
  if [ "${BUILD_TYPE}" == "iso_extraction" ]; then
      URL="${URL//REPLACE_ARCH/${ARCH}}"
      echo "Extracting from $URL"
      curl -C - --retry 5 --retry-delay 5 --retry-connrefused -Lf -o "${build_dir}/$(basename "${URL}")" "${URL}" || { echo "Failed to download ${URL}"; exit 1; }
      iso_extraction "$build_dir"
  elif [ "${BUILD_TYPE}" == "direct_file" ]; then
    echo "Building direct file download for ${OS} ${VERSION} (${ARCHS})"
    while read -r DL; do
        DLD="${DL//REPLACE_ARCH/$ARCH}"
        echo "Downloading: ${DLD}"
        URL="${DLD%|*}"
        OUT="${DLD#*|}"
        curl -C - --retry 5 --retry-delay 5 --retry-connrefused -Lf -o "${build_dir}/${OUT}" "${URL}" || { echo "Failed to download ${URL}"; exit 1; }
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

endpoints(){
  TMP_YAML="${output_dir}/endpoints.yml"
  # Create TMP_YAML if it doesn't exist
  if [ ! -f "$TMP_YAML" ]; then
    echo "Creating endpoints YAML file at $TMP_YAML"
    echo "endpoints:" > "$TMP_YAML"
  fi
  # Complete endpoints.yml
  KEY="${OS}-${VERSION}-${GENERIC_ARCH}"
  # Ensure the key exists in the YAML file
  yq e ".endpoints[\"${KEY}\"] = {}" -i "$TMP_YAML"
  # Safely write metadata with yq, all strings quoted
  yq e ".endpoints[\"${KEY}\"].path = \"/${GENERIC_ARCH}/${OS}/${VERSION}/releases/${RELEASE}/\"" -i "$TMP_YAML"
  yq e ".endpoints[\"${KEY}\"].os = \"${OS}\"" -i "$TMP_YAML"
  yq e ".endpoints[\"${KEY}\"].version = \"${VERSION}\"" -i "$TMP_YAML"
  yq e ".endpoints[\"${KEY}\"].arch = \"${GENERIC_ARCH}\"" -i "$TMP_YAML"
  # Extract filenames from EXTRACTS (right-hand side of '|')
  yq e ".endpoints[\"$KEY\"].files = []" -i "$TMP_YAML"
  while IFS='|' read -r _ dst; do
    yq e ".endpoints[\"$KEY\"].files += [\"$dst\"]" -i "$TMP_YAML"
  done <<< "$EXTRACTS"
}

if [ $# -ne 1 ]; then
  echo "Usage: $0 <asset_file>"
  exit 1
fi

asset="$1"
trigger "$asset"