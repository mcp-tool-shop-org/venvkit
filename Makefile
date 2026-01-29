# Venvkit - Makefile for Development
# Cross-platform development commands

.PHONY: help install dev test test-watch test-coverage lint format typecheck build clean verify audit

help:  ## Show this help message
	@echo "Venvkit Development Commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install:  ## Install dependencies
	npm ci

dev: install  ## Set up development environment
	@echo "Development environment ready!"
	@echo "Run 'make test' to run tests"
	@echo "Run 'make test-watch' for watch mode"

test:  ## Run all tests
	npm test

test-watch:  ## Run tests in watch mode
	npm run test:watch

test-coverage:  ## Run tests with coverage
	npm run test:coverage
	@echo "Coverage report generated"

lint:  ## Run linting checks
	npm run lint

format:  ## Format code with eslint
	npm run format

typecheck:  ## Run TypeScript type checking
	npm run typecheck

build:  ## Build the project
	npm run build

clean:  ## Clean build artifacts
	rm -rf dist coverage .vitest node_modules/.vitest
	@echo "Cleaned build artifacts"

verify:  ## Run all verification steps
	@echo "Running type checking..."
	@$(MAKE) typecheck
	@echo "Running linting..."
	@$(MAKE) lint
	@echo "Running tests..."
	@$(MAKE) test
	@echo "Running build..."
	@$(MAKE) build
	@echo "All checks passed!"

audit:  ## Run security audit
	npm audit

cli-test:  ## Test CLI with example
	npm run build
	node dist/map_cli.js --help

# Windows-specific helpers
.PHONY: install-windows test-windows clean-windows

install-windows:  ## Install on Windows (PowerShell)
	powershell -Command "npm ci"

test-windows:  ## Run tests on Windows
	powershell -Command "npm test"

clean-windows:  ## Clean on Windows
	powershell -Command "Remove-Item -Recurse -Force dist, coverage, node_modules\.vitest -ErrorAction SilentlyContinue"
