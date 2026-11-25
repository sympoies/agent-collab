import { useLocale } from "../i18n/LocaleProvider";
import type { Attention } from "../loader/attention";
import type { Message } from "../message/types";

export function AttentionView({
  attention,
  updatedAt,
  loading,
  topicCount,
  legacy,
  hasFollowed,
  onLoadAll,
  onOpenItem,
  onOpenMessage,
}: {
  readonly attention: Attention | null;
  readonly updatedAt: Date | null;
  readonly loading: boolean;
  readonly topicCount: number;
  readonly legacy: boolean;
  readonly hasFollowed: boolean;
  readonly onLoadAll: () => void;
  readonly onOpenItem: (topic: string, id: string) => void;
  readonly onOpenMessage: (message: Message) => void;
}) {
  const { t, formatDateTime } = useLocale();
  const checked = updatedAt === null ? "" : formatDateTime(updatedAt);
  const topicNames = (names: readonly string[]) =>
    names.length === 0
      ? t("attention.none")
      : names.map((topic) => t("topic.label", { topic })).join(", ");
  const openOnly = attention?.covered.filter((topic) => !attention.followed.includes(topic)) ?? [];
  return (
    <section className="attention-view" aria-label={t("heading.attention")}>
      {legacy && <p>{t("attention.legacyCoverage")}</p>}
      {!hasFollowed && <p>{t("attention.empty")}</p>}
      {loading && <p role="status">{t("attention.loading")}</p>}
      {attention !== null && !legacy && (
        <>
          <p className="attention-coverage">
            {t("attention.coverage", {
              covered: attention.covered.length,
              topics: topicCount,
              followed: attention.followed.length,
            })}
          </p>
          <ul className="attention-coverage-list">
            <li>
              {t("attention.openOnlyTopics", { date: checked })} {topicNames(openOnly)}
            </li>
            <li>
              {t("attention.followedPages", { date: checked })} {topicNames(attention.followed)}
            </li>
            {attention.withoutOpenFile.length > 0 && (
              <li>
                {t("attention.missingOpenTopics", { date: checked })}{" "}
                {topicNames(attention.withoutOpenFile)}
              </li>
            )}
            {attention.skipped.length > 0 && (
              <li>
                {t("attention.skippedTopics", { date: checked })} {topicNames(attention.skipped)}
              </li>
            )}
          </ul>
          {attention.skipped.length > 0 && (
            <p className="attention-load-all">
              <span>{t("attention.skipped", { count: attention.skipped.length })}</span>
              <button type="button" onClick={onLoadAll}>
                {t("attention.loadAll")}
              </button>
            </p>
          )}
        </>
      )}
      {attention !== null && legacy && attention.followed.length > 0 && (
        <p className="attention-coverage">
          {t("attention.followedPages", { date: checked })} {topicNames(attention.followed)}
        </p>
      )}
      {attention !== null && attention.rows.length > 0 && (
        <section aria-labelledby="attention-open-heading">
          <h3 id="attention-open-heading">{t("attention.openItems")}</h3>
          <ul>
            {attention.rows.map(({ topic, item }) => (
              <li key={`${topic}:${item.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    onOpenItem(topic, item.id);
                  }}
                >
                  <span>{t("topic.label", { topic })}</span>
                  <span>{item.section}</span>
                  {item.summary !== "" && <span>{item.summary}</span>}
                  <span>{item.from}</span>
                  {item.needs !== "" && <span>{item.needs}</span>}
                  <code>{item.id}</code>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {attention !== null && attention.messages.length > 0 && (
        <section aria-labelledby="attention-followed-heading">
          <h3 id="attention-followed-heading">{t("attention.followedMessages")}</h3>
          <ul>
            {attention.messages.map(({ topic, message }) => (
              <li key={message.path}>
                <button
                  type="button"
                  onClick={() => {
                    onOpenMessage(message);
                  }}
                >
                  <span>{t("topic.label", { topic })}</span>
                  <span>{message.from}</span>
                  <code>{message.id}</code>
                  <span>
                    {message.body.state === "plain"
                      ? message.body.lines.join(" ")
                      : t("chat.encrypted")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
