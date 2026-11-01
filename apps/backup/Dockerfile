FROM postgres:18

RUN apt-get update \
  && apt-get install -y --no-install-recommends age awscli ca-certificates jq \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/backup-postgres.sh scripts/restore-verify.sh /usr/local/bin/
RUN chmod 0555 /usr/local/bin/backup-postgres.sh /usr/local/bin/restore-verify.sh

ENTRYPOINT ["/usr/local/bin/backup-postgres.sh"]
