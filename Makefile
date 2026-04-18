.PHONY: run clean

# Boot the Firebase emulator suite. Imports seed data from
# .emulator-data/ and exports on clean shutdown (Ctrl+C).
run:
	./scripts/start-emulators.sh

# Wipe persisted emulator state. Next `make run` boots empty:
# no Auth users, no Firestore docs, no Storage objects.
clean:
	rm -rf .emulator-data
