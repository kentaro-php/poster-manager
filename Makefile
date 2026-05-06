# poster-manager Makefile
# 使い方:
#   make            ヘルプ表示
#   make status     現在の状態を確認
#   make deploy     変更を add→commit→push（メッセージ自動生成）
#   make deploy m="コミットメッセージ"  メッセージを指定して push
#   make serve      ローカルサーバーを起動（プレビュー用）
#   make open       公開サイトをブラウザで開く

# デフォルトのコミットメッセージ（make deploy 時に上書きされなければこれ）
DEFAULT_MSG := Update $(shell date +%Y-%m-%d_%H:%M)

# 公開URL
LIVE_URL := https://kentaro-php.github.io/poster-manager/

.PHONY: help status deploy serve open clean

# デフォルトターゲット（引数なしで make したら表示）
help:
	@echo ""
	@echo "  📋 poster-manager デプロイ補助"
	@echo ""
	@echo "  使えるコマンド:"
	@echo "    make status               現在の状態を確認"
	@echo "    make deploy               変更を全部 push（自動メッセージ）"
	@echo "    make deploy m=\"説明\"      メッセージを指定して push"
	@echo "    make serve                ローカルプレビュー起動"
	@echo "    make open                 公開サイトを開く"
	@echo ""
	@echo "  公開URL: $(LIVE_URL)"
	@echo ""

# 現在の状態を表示
status:
	@echo ""
	@echo "📂 ローカル変更:"
	@git status --short || true
	@echo ""
	@echo "📝 直近のコミット:"
	@git log --oneline -5 || true
	@echo ""
	@echo "🌐 リモート同期:"
	@git fetch --quiet 2>/dev/null && \
		LOCAL=$$(git rev-parse @) && \
		REMOTE=$$(git rev-parse @{u} 2>/dev/null) && \
		if [ "$$LOCAL" = "$$REMOTE" ]; then \
			echo "  ✓ 同期済み"; \
		else \
			echo "  ⚠ ローカルとリモートに差分あり"; \
		fi
	@echo ""

# 一発デプロイ
deploy:
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
		echo ""; \
	fi

# ローカルサーバー起動（プレビュー用）
serve:
	@echo ""
	@echo "  🔧 ローカルプレビューを起動します"
	@echo "  ブラウザで http://localhost:8000 を開いてください"
	@echo "  停止: Ctrl+C"
	@echo ""
	@python3 -m http.server 8000

# 公開サイトをブラウザで開く
open:
	@open $(LIVE_URL)

# キャッシュクリア（必要なら）
clean:
	@find . -name ".DS_Store" -delete
	@echo "  🧹 .DS_Store を削除しました"
