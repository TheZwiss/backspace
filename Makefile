# Raspberry Pi Deployment Makefile (Direct SSH)

PI_IP = 192.168.1.10
PI_USER = youruser
REMOTE_PATH = ~/opencord

.PHONY: deploy logs shell env status

# Full deployment: sync code and rebuild/restart containers ON the Pi
deploy:
	@chmod +x deploy.sh
	./deploy.sh

# Watch real-time logs FROM the Pi server
logs:
	ssh $(PI_USER)@$(PI_IP) "cd $(REMOTE_PATH) && docker compose logs -f"

# Drop into a shell inside the running container ON the Pi
shell:
	ssh -t $(PI_USER)@$(PI_IP) "docker exec -it opencord /bin/bash"

# Push local .env to the Pi (do this once)
env:
	@echo "📤 Pushing .env to Pi..."
	ssh $(PI_USER)@$(PI_IP) "mkdir -p $(REMOTE_PATH)"
	scp .env $(PI_USER)@$(PI_IP):$(REMOTE_PATH)/.env

# Check container status ON the Pi
status:
	ssh $(PI_USER)@$(PI_IP) "cd $(REMOTE_PATH) && docker compose ps"
