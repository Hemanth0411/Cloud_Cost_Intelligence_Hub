# Thin wrapper. ./do.sh is the real implementation -- the dev machine is
# Windows and has no `make`, so duplicating the logic here would mean two
# implementations and one of them rotting.
#
#   make build
#   make up ENV=dev
#   make teardown ENV=dev
#
# Or directly:  ./do.sh up dev

.PHONY: help build test up migrate outputs export-data teardown sweep restore

help:        ; @./do.sh help
build:       ; @./do.sh build
test:        ; @./do.sh test
up:          ; @./do.sh up $(ENV)
migrate:     ; @./do.sh migrate $(ENV)
outputs:     ; @./do.sh outputs $(ENV)
export-data: ; @./do.sh export-data $(ENV)
teardown:    ; @./do.sh teardown $(ENV)
sweep:       ; @./do.sh sweep $(ENV)
restore:     ; @./do.sh restore $(ENV) $(FILE)
