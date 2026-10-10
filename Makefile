# zizvideo —— 独立项目（短视频/短剧；面板通过镜像索引 apps/zizvideo/manifest.json 取版本与产物）
#
# 版本真源 = 下面这一行 + internal/api/api.go 的 Version 常量（两处必须一致，make check 会核对）。
# 面板侧不要求跟着发版：它读镜像索引里的 latest，所以**只需**在本仓库发版。
GO        ?= go
VERSION   ?= 0.6.5-mvp
ARCHS     ?= arm64              # 默认只发 arm64；要双架构：make release ARCHS="arm64 amd64"
FPK_ARCH  ?= amd64              # 飞牛 .fpk 的架构（x86 设备居多）
# Linux 产物（用户 2026-10-11："完善独立部署…含 Linux/systemd 路径"、飞牛 NAS 用得上）。
# 与 darwin 分开：**不签名**（Linux 没有 codesign），也**不进 manifest.json** —— 那份是面板的
# 契约，只认 darwin 且按 arch 选包，同 arch 塞两个平台会让面板装错平台。Linux 走独立的
# linux.json（与 android.json 同一思路：平台专属、稳定路径）。
LINUX_ARCHS ?= amd64 arm64
DIST      ?= dist
APPDIR    ?= $(DIST)/apps/zizvideo
VERDIR    ?= $(APPDIR)/$(VERSION)
SIGN_IDENT ?= com.zizvideo.server
CODESIGN   ?= tools/codesign-release.sh
CODESIGN_CERT ?= .release-key/codesign/zp-codesign.crt
LDFLAGS   := -X github.com/zizdog/zizvideo/internal/api.Version=$(VERSION)
# 只给发布件瘦身：-s -w 去掉符号表/DWARF（实测 17.2MB → 11.5MB，少传 33% 字节）。
# 本地 build 不加，保留调试符号。
RELEASE_LDFLAGS := -s -w $(LDFLAGS)

# 国内网络下 proxy.golang.org 常不可达
export GOPROXY ?= https://goproxy.cn,direct

.PHONY: help check check-run test test-serial vet fmt build run fixtures release index publish publish-app verify version

help: ## 列出目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

version: ## 打印本仓库版本号
	@echo $(VERSION)

# check 是硬门禁，但**同一棵树**重复跑它没有新信息（发版时会连跑好几次）。
# 判据是工作树内容指纹（tools/check-stamp.sh）：改一个字节就失效、必须重跑；
# 提交前后内容不变则指纹不变，所以"提交完再发版"不会白跑一遍。
check: ## 日常门禁：版本一致 + 前端 JS 真解析 + go vet + 单测（同一棵树跑过就跳过）
	@if out="$$(bash tools/check-stamp.sh verify 2>&1)"; then \
	   echo "==> 跳过 make check：$$out"; \
	   echo "    （改一个字节就会重跑；要强制：ZV_FORCE_CHECK=1 make check）"; \
	 else \
	   $(MAKE) --no-print-directory check-run || exit 1; \
	   bash tools/check-stamp.sh write; \
	 fi

check-run: ## 真正跑一遍门禁（不做指纹跳过）
	@echo "==> 版本号：Makefile 与 internal/api/api.go 一致 + 守规矩（末段 0～10：0.1.10 之后是 0.2.0）"
	@node tools/check-version-rule.mjs .
	@echo "==> 独立部署安装器（语法 + --purge 删除前守门 + listen 写入 + 回滚 + 证书指纹；全程沙箱）"
	@bash tools/test-installer.sh
	@echo "==> 前端 JS 语法（真 ES 解析器；缺 acorn 直接失败，不静默跳过）"
	@node -e "import('acorn').then(()=>0,()=>{console.error('!! 无法导入 acorn —— 先 npm install（白屏级错误只有它能抓）');process.exit(1)})"
	@node tools/check-js-syntax.mjs internal/web/assets
	@node tools/check-js-undeclared.mjs internal/web/assets
	@echo "==> 前端兼容（老电视 WebView 缺的 JS API + CSS 写法棘轮 + 禁用原生弹窗）"
	@node tools/check-js-compat.mjs internal/web/assets
	@$(MAKE) --no-print-directory vet
	@$(MAKE) --no-print-directory test
	@echo "检查通过 ✅"

# 不重复算同一件事：重包按测试名单分片并行 + **不关 go 测试缓存**（见 tools/test-fast.sh）
test: ## 单元测试（重包分片并行、启用 go 缓存；不碰真机系统状态）
	@bash tools/test-fast.sh

test-serial: ## 老写法（串行 + 禁缓存），排查可疑缓存时用
	$(GO) test ./... -count=1

vet: ## 静态检查
	$(GO) vet ./...

fmt: ## 格式化
	gofmt -l -w .

build: ## 本机架构构建到 dist/zizvideo
	@mkdir -p $(DIST)
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "$(LDFLAGS)" -o $(DIST)/zizvideo ./cmd/server
	@echo "构建完成：$(DIST)/zizvideo ($(VERSION))"

run: build ## 用本机默认配置跑起来（调试用；别抢 7766）
	./$(DIST)/zizvideo

fixtures: ## 生成测试样本视频
	./scripts/gen-fixtures.sh

# ---------------------------------------------------------------- 发布 --
# release：构建 → 固定证书签名（identifier com.zizvideo.server）→ 写版本目录 + 镜像索引
# 产出的 dist/apps/zizvideo/ 就是"镜像上 apps/zizvideo/ 的样子"，publish 只负责传上去。
release: ## 产出 dist/apps/zizvideo/（<版本>/ 产物 + 顶层索引 manifest.json）
	@rm -rf $(VERDIR) && mkdir -p $(VERDIR)
	@set -e; \
	for arch in $(ARCHS); do \
	  echo "==> 构建 darwin/$$arch"; \
	  GOOS=darwin GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false \
	    -ldflags "$(RELEASE_LDFLAGS)" -o "$(VERDIR)/zizvideo_$(VERSION)_darwin_$$arch" ./cmd/server; \
	  chmod 0755 "$(VERDIR)/zizvideo_$(VERSION)_darwin_$$arch"; \
	  if [ -f $(CODESIGN_CERT) ]; then \
	    bash $(CODESIGN) "$(VERDIR)/zizvideo_$(VERSION)_darwin_$$arch" $(SIGN_IDENT); \
	  else \
	    echo "    !! 没有 $(CODESIGN_CERT)：产物未签名，用户每次升级都要重新授权"; \
	  fi; \
	done
	@set -e; \
	for arch in $(LINUX_ARCHS); do \
	  echo "==> 构建 linux/$${arch}（CGO_ENABLED=0，静态，不签名）"; \
	  GOOS=linux GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false \
	    -ldflags "$(RELEASE_LDFLAGS)" -o "$(VERDIR)/zizvideo_$(VERSION)_linux_$$arch" ./cmd/server; \
	  chmod 0755 "$(VERDIR)/zizvideo_$(VERSION)_linux_$$arch"; \
	done
	@# 安卓客户端（可选）：有 release APK 就一起放进版本目录，随索引一起发；
	@# 没有 Android 工具链的机器不会因此失败 —— 服务端发布不依赖客户端。
	@APK=android/app/build/outputs/apk/release/app-release.apk; \
	 if [ -f "$$APK" ]; then \
	   AV=$$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' android/app/build.gradle.kts | head -1); \
	   cp "$$APK" "$(VERDIR)/zizvideo-android-$$AV.apk"; \
	   echo "    ✓ 已带上安卓客户端：zizvideo-android-$$AV.apk（$$(wc -c < "$$APK" | tr -d ' ') 字节）"; \
	 else \
	   echo "    （没有安卓 release APK，跳过；要带客户端先 cd android && bash tools/build.sh）"; \
	 fi
	@# 索引放在**客户端拷好之后**算：make-app-index.py 还要按 APK 生成 android.json（App 自动更新源），
	@# 顺序反了它就看不到 APK（0.2.10 这轮实测踩到：android.json 一直不生成）。
	@python3 tools/make-app-index.py $(VERDIR) $(VERSION)
	@echo "发布件就绪：$(APPDIR)（下一步：make publish）"

index: ## 只按现有版本目录重算索引（产物没重编时用）
	@python3 tools/make-app-index.py $(VERDIR) $(VERSION)

publish-app: ## 只发安卓客户端（APK + android.json），不动服务端（改的只有安卓代码时用）
	@bash tools/publish-mirror.sh --app-only

release-check: ## 发版前自检 dist 里的索引与产物是否对得平（sha256/size/签名/静态 ELF）
	@bash tools/check-release-dir.sh

publish: ## 把 dist/apps/zizvideo/ 传到公网镜像 apps/zizvideo/（走 mini 面板接口）
	@bash tools/check-release-dir.sh
	@bash tools/publish-mirror.sh

# DEEP=1 走整包下载复算（快验只比 Content-Length，发现不了"同长度被换过"）。
# ⚠️ 老写法 `make verify DEEP=1` 是**静默退化**成快验的（Makefile 没把它 export 给脚本），
# 2026-10-11 审计抓到：操作者以为做了字节级复验。现在真传下去。
DEEP ?= 0
export VERIFY_DEEP = $(DEEP)

# ⚠️ 目标名不能叫 `fnos`：仓库里有个**目录** fnos/，make 会认为目标已存在而跳过配方。
fpk: ## 打飞牛（fnOS）应用包：准备待打包目录 + 有 fnpack 就出 .fpk（FPK_ARCH=amd64|arm64）
	@bash tools/make-fnos-pkg.sh --arch $(FPK_ARCH) $(if $(filter 1,$(STAGE_ONLY)),--stage-only,)

smoke: ## 端到端冒烟：真二进制 + 真 ffmpeg + 临时数据目录，跑一遍短视频/短剧全链路
	@python3 tools/smoke-e2e.py

verify: ## 复验线上镜像（DEEP=1 整包下载复算 sha256；不加只做快验）
	@bash tools/publish-mirror.sh --verify-only $(if $(filter 1,$(DEEP)),--deep,)
