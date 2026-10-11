#!/usr/bin/env python3
"""apk-signer-info.py —— 不依赖 Java，从 APK 里取出**签名证书**（APK Signature Scheme v2/v3）

为什么需要它：验 APK 签名的标准工具是 `apksigner`（要 Java 运行时）。如果机器上只有 macOS 的 `java`
占位符（提示装 JDK），就验不了 —— 而"这个 APK 到底是不是我们的密钥签的"是**使用者安全**相关的事实
（被改过/别人重签的包会以我们的名义让用户安装）。这里直接解析 **APK Signing Block** 把签名证书抽出来，
再用 openssl 打印主体与指纹，足以回答"谁签的"。

APK Signing Block 在 ZIP 中央目录之前：
    [uint64 块大小][若干 ID-value 对][uint64 块大小][魔数 "APK Sig Block 42"][中央目录]
对里 ID 0x7109871a = v2 方案、0xf05368c0 = v3 方案；signer 的 signed_data 里依次是
digests / **certificates** / additional_attributes。

用法：python3 tools/apk-signer-info.py <app.apk>      退出码 0=抽到证书，1=抽不到（如实说不猜）
"""
import struct
import subprocess
import sys
import tempfile

MAGIC = b"APK Sig Block 42"
V2_ID = 0x7109871A
V3_ID = 0xF05368C0


def u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def u64(data, off):
    return struct.unpack_from("<Q", data, off)[0]


def signing_block(data):
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("找不到 EOCD（不是 ZIP/APK？）")
    cd = u32(data, eocd + 16)
    # 魔数是 **16 字节**（"APK Sig Block 42"），位于中央目录前 16 字节处；第一版只比了 8 字节 ⇒ 永远不匹配
    if cd < 32 or data[cd - 16:cd] != MAGIC:
        raise ValueError("没有 APK Signing Block（可能只做了 v1 签名，或根本不是 APK）")
    # 布局（Android 文档）：[uint64 块大小][ID-value 对…][uint64 同一块大小][16 字节魔数][中央目录]
    # ⇒ 尾部那个大小字段在 cd-24；块起点 = cd-24-size；首尾两个大小字段必须相等（这条自检救了我两次）
    # 实测（本仓库的 0.4.5 包）：尾部 size 在 cd-24，且 size 含"pairs + 尾部 size + 16 字节魔数"
    # ⇒ 块起点 = cd - 8 - size（首尾两个 size 字段相等，这条自检留着一路兜底）
    size = u64(data, cd - 24)
    start = cd - 8 - size
    if start < 0 or u64(data, start) != size:
        raise ValueError("签名块长度字段自相矛盾（文件被截断/改过？）")
    pairs = {}
    off = start + 8
    end = cd - 24
    while off < end:
        plen = u64(data, off)
        pid = u32(data, off + 8)
        pairs[pid] = data[off + 12:off + 8 + plen]
        off += 8 + plen
    return pairs


def first_cert_v2(block, v3=False):
    """从 v2/v3 方案块里取出第一张签名证书（DER）。"""
    n = u32(block, 0)
    off = 4
    if n < 4:
        raise ValueError("signers 列表为空")
    slen = u32(block, off)
    off += 4
    signer = block[off:off + slen]
    p = 0
    if v3:                                     # v3 的 signer 外面包了 min/max SDK
        p += 8
    sd_len = u32(signer, p)
    p += 4
    sd = signer[p:p + sd_len]
    q = u32(sd, 0)                             # digests
    q += 4
    certs_len = u32(sd, q)
    q += 4
    clen = u32(sd, q)
    return sd[q + 4:q + 4 + clen]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        data = open(sys.argv[1], "rb").read()
        pairs = signing_block(data)
    except Exception as exc:                                     # noqa: BLE001
        print("抽不到签名块：%s" % exc)
        return 1
    if not pairs:
        print("签名块里没有 ID-value 对")
        return 1
    print("签名方案：%s" % ", ".join(
        ("v2" if k == V2_ID else "v3" if k == V3_ID else "0x%08x" % k) for k in sorted(pairs)))
    der = None
    for pid, v3 in ((V2_ID, False), (V3_ID, True)):
        if pid in pairs:
            try:
                der = first_cert_v2(pairs[pid], v3=v3)
                break
            except Exception as exc:                             # noqa: BLE001
                print("解析 %s 失败：%s" % ("v3" if v3 else "v2", exc))
    if not der:
        print("没能从签名块里取出证书（如实说不猜）")
        return 1
    with tempfile.NamedTemporaryFile(suffix=".der", delete=False) as f:
        f.write(der)
        path = f.name
    import hashlib
    print("签名证书 DER sha256：%s（%d 字节）" % (hashlib.sha256(der).hexdigest(), len(der)))
    for args in (["-noout", "-subject", "-issuer", "-dates", "-fingerprint", "-sha256"],
                 ["-noout", "-fingerprint", "-sha1"]):
        out = subprocess.run(["openssl", "x509", "-inform", "der", "-in", path] + args,
                             capture_output=True, text=True)
        if out.stdout.strip():
            print(out.stdout.strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
