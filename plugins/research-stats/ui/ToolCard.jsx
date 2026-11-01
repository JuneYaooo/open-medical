import { Sigma } from "lucide-react";

export default function ResearchStatsToolCard({ onNavigate }) {
  return <article>
    <a className="tool-card-link" href="?view=data-analysis" onClick={event => {
      event.preventDefault();
      onNavigate("data-analysis");
    }}>
      <Sigma size={24} />
      <h2>科研统计</h2>
      <p>用一句话提出研究问题，助手从本地患者库建队列并做统计；也可上传 CSV 自行分析。</p>
      <footer>
        <small>本地</small>
      </footer>
    </a>
  </article>;
}
