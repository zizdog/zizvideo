# zizvideo —— 独立项目（短视频/短剧；面板通过镜像索引 apps/zizvideo/manifest.json 取版本与产物）
#
# 版本真源 = 下面这一行 + internal/api/api.go 的 Version 常量（两处必须一致，make check 会核对）。
# 面板侧不要求跟着发版：它读镜像索引里的 latest，所以**只需**在本仓库发版。
GO        ?= go
VERSION   ?= 0.1.3-mvp
ARCHS     ?= arm64              # 默认只发 arm64；要双架构：make release ARCHS="arm64 amd64"
DIST      ?= dist
APPDIR    ?= $(DIST)/apps/zizvideo
VERDIR    ?= $(APPDIR)/$(VERSION)
SIGN_IDENT ?= com.zizvideo.server
CODESIGN   ?= tools/codesign-release.sh
CODESIGN_CERT ?= .release-key/codesign/zp-codesign.crt
LDFLAGS   := -X github.com/zizdog/zizvideo/internal/api.Version=$(VERSION)

# 国内网络下 proxy.golang.org 常不可达
export GOPROXY ?= https://goproxy.cn,direct

.PHONY: help check test vet fmt build run fixtures release index publish verify version

help: ## 列出目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

version: ## 打印本仓库版本号
	@echo $(VERSION)

check: ## 日常门禁：版本一致 + 前端 JS 真解析 + go vet + 单测
	@echo "==> 版本号一致（Makefile vs internal/api/api.go）"
	@src=$$(sed -n 's/.*var Version = "\(.*\)".*/\1/p' internal/api/api.go | head -1); \
	 if [ "$$src" != "$(VERSION)" ]; then \
	   echo "!! internal/api/api.go 的 Version=$$src 与 Makefile 的 $(VERSION) 不一致"; exit 1; fi; \
	 echo "   ok：$(VERSION)"
	@echo "==> 前端 JS 语法（真 ES 解析器；缺 acorn 直接失败，不静默跳过）"
	@[ -d node_modules/acorn ] || { echo "!! 缺 node_modules/acorn —— 先 npm install（白屏级错误只有它能抓）"; exit 1; }
	@node tools/check-js-syntax.mjs internal/web/assets
	@node tools/check-js-undeclared.mjs internal/web/assets
	@$(MAKE) --no-print-directory vet
	@$(MAKE) --no-print-directory test
	@echo "检查通过 ✅"

test: ## 单元测试（不碰真机系统状态）
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
	    -ldflags "$(LDFLAGS)" -o "$(VERDIR)/zizvideo_$(VERSION)_darwin_$$arch" ./cmd/server; \
	  chmod 0755 "$(VERDIR)/zizvideo_$(VERSION)_darwin_$$arch"; \
	  if [ -f $(CODESIGN_CERT) ]; then \
	    bash $(CODESIGN) "$(VERDIR)/zizvideo_$(VERSION)_darwin_$$arch" $(SIGN_IDENT); \
	  else \
	    echo "    !! 没有 $(CODESIGN_CERT)：产物未签名，用户每次升级都要重新授权"; \
	  fi; \
	done
	@python3 tools/make-app-index.py $(VERDIR) $(VERSION)
	@echo "发布件就绪：$(APPDIR)（下一步：make publish）"

index: ## 只按现有版本目录重算索引（产物没重编时用）
	@python3 tools/make-app-index.py $(VERDIR) $(VERSION)

publish: ## 把 dist/apps/zizvideo/ 传到公网镜像 apps/zizvideo/（走 mini 面板接口）
	@bash tools/publish-mirror.sh

verify: ## 复验线上镜像：索引 latest / sha256 / --version
	@bash tools/publish-mirror.sh --verify-only
