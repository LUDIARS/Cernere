// scripts/init-env.ts
import { execFileSync } from "node:child_process";
import config from "../path/to/your/config.js"; // ※実際の config ファイルのパスに変更してください

const initSecrets = () => {
  const env = config.defaultEnvironment || "dev";
  const pathStr = "/";

  console.log(`🚀 Infisical に環境変数を直接登録します (環境: ${env})...`);
  console.log(`※実行前に 'infisical login' および対象ディレクトリでの 'infisical init' が済んでいるか確認してください。\n`);

  for (const [key, value] of Object.entries(config.infraKeys)) {
    console.log(`Setting ${key}...`);
    
    try {
      // execFileSync の配列引数として渡すことで、特殊文字が含まれていても安全に処理されます
      execFileSync(
        "infisical",
        [
          "secrets",
          "set",
          `${key}=${value}`,
          "--env",
          env,
          "--path",
          pathStr
        ],
        { stdio: "pipe" } // 成功時のCLIの標準出力を非表示にしてスッキリさせる
      );
      console.log(`  ✅ Success`);
    } catch (error: any) {
      console.error(`  ❌ Failed: ${key} の登録に失敗しました。`);
      
      // Infisical CLI からのエラーメッセージがあれば表示
      if (error.stderr) {
        console.error(`     Error details: ${error.stderr.toString().trim()}`);
      }
    }
  }

  console.log(`\n✨ すべての初期設定が完了しました！`);
};

initSecrets();