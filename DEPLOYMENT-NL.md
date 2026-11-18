# Secret Santa – beveiligingsupdate

Deze versie voegt wederzijdse uitsluitingen toe en verplaatst het opslaan van een volledige trekking naar één database-transactie.

## Bestanden

- `supabase/migrations/20261119000000_secure_secret_santa.sql`: databasewijzigingen en atomische RPC.
- `supabase/functions/create-draw/index.ts`: admincontrole, validatie, matching en één atomische databaseaanroep.
- `supabase/functions/get-result/index.ts`: ophalen van resultaten via de gehashte geheime token.
- `index.html`: beheerformulier met uitsluitingen.

## Belangrijk vóór deployment

De migratie is geschreven voor het schema dat in de aangeleverde database-uitvoer stond. De bestaande tabellen `events`, `participants`, `assignments` en `admin_users` moeten aanwezig zijn. De bestaande evenementen, deelnemers en assignments zijn volgens de aangeleverde controle al verwijderd. `admin_users` blijft behouden.

Maak desondanks een Supabase-back-up voordat je de migratie uitvoert. Voer de SQL-migratie precies één keer uit via Supabase Dashboard → SQL Editor, of gebruik de Supabase CLI-migraties. Voer hem niet opnieuw uit nadat hij succesvol is toegepast.

## Deployvolgorde

1. Commit de bijgewerkte `index.html`, `supabase/functions/` en `supabase/migrations/` naar GitHub.
2. Voer de SQL-migratie uit op het juiste Supabase-project.
3. Controleer dat de Edge Function secrets bestaan:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SITE_URL`
4. `SITE_URL` moet de volledige publieke URL van de website zijn, bijvoorbeeld `https://gebruikersnaam.github.io/secret-santa/`. De origin daarvan wordt gebruikt voor CORS.
5. Deploy beide Edge Functions:
   ```bash
   supabase functions deploy create-draw
   supabase functions deploy get-result
   ```
6. Publiceer de nieuwe `index.html` via GitHub Pages.

**Zet nooit `SUPABASE_SERVICE_ROLE_KEY` in `index.html`, GitHub of andere publieke bestanden.** Alleen de publishable/anon key hoort in de browser.

## Uitsluitingen invoeren

In het beheerdersformulier staat nu een veld “Wederzijdse uitsluitingen”. Gebruik één duo per regel:

```text
Emma;Lucas
Noah;Sofie
```

De uitsluiting geldt automatisch in beide richtingen. Namen moeten overeenkomen met de deelnemerslijst. Een deelnemer kan zichzelf niet uitsluiten. Dubbele duo's worden geweigerd.

Als er met de opgegeven uitsluitingen geen volledige geldige trekking bestaat, wordt de aanvraag geweigerd voordat er gegevens worden opgeslagen.

## Beveiligingsgedrag

- Namen zijn uniek per evenement, hoofdletterongevoelig en zonder voor-/achterspaties.
- Niet-lege telefoonnummers zijn uniek per evenement na normalisatie naar cijfers.
- Eén deelnemer kan maar één persoon trekken en maar één keer getrokken worden.
- Zelftrekkingen en koppelingen tussen verschillende evenementen worden door de database verhinderd.
- Een trekking, inclusief event, deelnemers, uitsluitingen en assignments, wordt in één databasefunctie/transactie opgeslagen.
- Als een insert of validatie faalt, rolt PostgreSQL de volledige transactie terug.
- De databasefunctie is alleen uitvoerbaar door `service_role`; de Edge Function controleert daarnaast de ingelogde gebruiker en `admin_users`.
- RLS blijft ingeschakeld. De browser gebruikt geen rechtstreekse tabeltoegang.

De matching is cryptografisch gerandomiseerd qua kandidaatvolgorde en zoekt een geldige volledige matching. De methode garandeert geldigheid, maar is geen mathematisch uniforme trekking over alle mogelijke geldige matchings.

## Test na deployment

1. Maak een test-event met 4 deelnemers en zonder uitsluitingen.
2. Maak een tweede test-event met een wederzijdse uitsluiting, bijvoorbeeld `Emma;Lucas`.
3. Controleer dat geen van beiden de ander trekt.
4. Test een onmogelijke combinatie, bijvoorbeeld met 2 deelnemers die elkaar uitsluiten. De aanvraag moet worden geweigerd en er mag geen event of deelnemer achterblijven.
5. Test dubbele namen en dubbele telefoonnummers; beide moeten worden geweigerd.
6. Open één persoonlijke link en controleer dat alleen de naam van de toegewezen ontvanger verschijnt.

Voer geen test uit met echte deelnemerslinks die al gedeeld zijn.
