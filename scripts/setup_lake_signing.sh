#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "此脚本只用于 macOS" >&2
  exit 1
fi

identity='Lake Local Development Code Signing'
if security find-identity -v -p codesigning | grep -Fq "\"$identity\""; then
  echo "Lake 本地签名身份已存在"
  exit 0
fi

lake_signing_tmp=$(mktemp -d "${TMPDIR:-/tmp}/lake-signing.XXXXXX")
trap 'rm -rf "$lake_signing_tmp"' EXIT HUP INT TERM
chmod 700 "$lake_signing_tmp"

cat > "$lake_signing_tmp/openssl.cnf" <<'EOF'
[req]
distinguished_name = subject
x509_extensions = codesign
prompt = no

[subject]
CN = Lake Local Development Code Signing

[codesign]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -config "$lake_signing_tmp/openssl.cnf" -extensions codesign \
  -keyout "$lake_signing_tmp/key.pem" -out "$lake_signing_tmp/cert.pem" >/dev/null 2>&1

lake_bundle_password=$(openssl rand -hex 24)
openssl pkcs12 -export -legacy -inkey "$lake_signing_tmp/key.pem" \
  -in "$lake_signing_tmp/cert.pem" -out "$lake_signing_tmp/identity.p12" \
  -passout "pass:$lake_bundle_password" >/dev/null 2>&1

lake_login_keychain="$HOME/Library/Keychains/login.keychain-db"
security import "$lake_signing_tmp/identity.p12" -k "$lake_login_keychain" \
  -P "$lake_bundle_password" -T /usr/bin/codesign

echo "接下来 macOS 会要求批准此证书用于代码签名，请按系统提示输入登录钥匙串密码。"
security add-trusted-cert -r trustRoot -p codeSign \
  -k "$lake_login_keychain" "$lake_signing_tmp/cert.pem"

if ! security find-identity -v -p codesigning | grep -Fq "\"$identity\""; then
  echo "签名身份尚未生效；请在钥匙串访问中检查证书信任状态" >&2
  exit 1
fi
echo "Lake 本地签名身份已就绪。运行 scripts/build_lake.sh 编译并签名。"
