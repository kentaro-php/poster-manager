# poster-manager Makefile (macOS互換)
# 使い方:
#   make            ヘルプ表示
#   make status     現在の状態を確認
#   make deploy     変更を add→commit→push（自動キャッシュバスティング）
#   make deploy m="メッセージ"  メッセージ指定
#   make serve      ローカルサーバー起動
#   make open       公開サイトを開く

DEFAULT_MSG := Update $(shell date +%Y-%m-%d_%H:%M)
LIVE_URL := https://kentaro-php.github.io/poster-manager/

.PHONY: help status deploy serve open clean bump-version

help:
	@echo ""
	@echo "  📋 poster-manager デプロイ補助"
	@echo ""
	@echo "  make status               現在の状態を確認"
	@echo "  make deploy               変更を全部 push（自動キャッシュバスティング）"
	@echo "  make deploy m=\"説明\"      メッセージ指定 push"
	@echo "  make serve                ローカルプレビュー起動"
	@echo "  make open                 公開サイトを開く"
	@echo ""
	@echo "  公開URL: $(LIVE_URL)"
	@echo ""

status:
	@echo ""
	@echo "📂 ローカル変更:"
	@git status --short || true
	@echo ""
	@echo "📝 直近のコミット:"
	@git log --oneline -5 || true
	@echo ""

# index.htmlのバージョン番号を現在時刻に書き換え（Python使用、OSの違いを吸収）
bump-version:
	@python3 -c "import re, datetime, os; \
		path='index.html'; \
		ts=datetime.datetime.now().strftime('%Y%m%d-%H%M%S'); \
		content=open(path).read(); \
		new=re.sub(r'(\.(?:css|js))\?v=[^\"]*', r'\1?v=' + ts, content); \
		open(path,'w').write(new); \
		print('  🔄 バージョンを ' + ts + ' に更新') if content != new else print('  ℹ️  バージョン目印が見つかりません')"

deploy: bump-version
	@if [ -z "$$(git status --porcelain)" ]; then \
		echo ""; \
		echo "  📭 ローカルに変更はありません。"; \
		echo "  リモートとの同期だけ行います..."; \
		echo ""; \
		git push 2>&1 || true; \
	else \
		echo ""; \
		echo "  📦 変更内容:"; \
		git status --short; \
		echo ""; \
		MSG="$${m:-$(DEFAULT_MSG)}"; \
		echo "  💬 コミットメッセージ: $$MSG"; \
		echo ""; \
		git add -A && \
		git commit -m "$$MSG" && \
		echo "" && \
		echo "  🚀 push 中..." && \
		git push && \
		echo "" && \
		echo "  ✅ デプロイ完了!"; \
		echo "  ⏱  GitHub Pagesの反映に1〜2分かかります"; \
		echo "  🌐 $(LIVE_URL)"; \
		echo "  💡 ブラウザのキャッシュ削除は不要です"; \
		echo ""; \
	fi

serve:
	@echo ""
	@echo "  🔧 ローカルプレビューを起動します"
	@echo "  ブラウザで http://localhost:8000 を開いてください"
	@echo "  停止: Ctrl+C"
	@echo ""
	@python3 -m http.server 8000

open:
	@open $(LIVE_URL)

clean:
	@find . -name ".DS_Store" -delete
	@echo "  🧹 .DS_Store を削除しました"
