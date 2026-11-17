.PHONY: setup run upgrade logs

setup:
	docker run --rm -it --user "$$(id -u):$$(id -g)" \
		--mount "type=bind,source=$(CURDIR),target=/app" --workdir /app \
		-e APP_ORIGIN=https://quota.chillix.me \
		node:24.16-bookworm-slim node scripts/setup.mjs

run:
	docker compose --profile tunnel up -d --build

upgrade:
	git pull --ff-only
	docker compose --profile tunnel up -d --build

logs:
	docker compose --profile tunnel logs -f --tail=100
