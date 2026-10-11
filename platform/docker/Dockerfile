# ============================================================================
#  zizvideo 容器镜像（用发行版里的**静态** Linux 二进制，不在镜像里编译）
#
#  为什么不在镜像里编译：Go 工具链会让镜像大几百 MB，而我们的产物是 CGO_ENABLED=0 的
#  静态二进制（`make release` 会同时出 linux/amd64 与 linux/arm64）。构建步骤见
#  docs/独立部署.md 的 Docker 一节：先 `make release`，再把对应架构的二进制拷到这里。
#
#  用 alpine 而不是 distroless：入口脚本要 sh 与 python3 来生成/校验配置（见 entrypoint.sh）。
#  ============================================================================
FROM alpine:3.20

# python3 只用于生成/合并 config.json（很小）；其余什么都不装
RUN apk add --no-cache python3 && addgroup -S zizvideo && adduser -S -G zizvideo zizvideo

COPY zizvideo /usr/local/bin/zizvideo
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/zizvideo /usr/local/bin/entrypoint.sh

# 数据目录（数据库/封面/收件箱）：必须挂出来，否则容器一删数据就没了
VOLUME ["/data"]
EXPOSE 7766

# 非 root 运行；宿主挂载目录的属主要与该 uid 对得上（见文档）
USER zizvideo

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
