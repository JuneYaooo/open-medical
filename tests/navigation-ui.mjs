export async function openTool(page, name) {
  await page.getByRole('navigation', {name:'资料与工具', exact:true}).getByRole('button').click();
  await page.getByRole('link').filter({has:page.getByRole('heading',{name,exact:true})}).click();
}
export async function openPatient(page, name) {
  await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
  await page.locator('.patient-card').filter({hasText:name}).click();
}
export async function openIntake(page) {
  const picker=page.getByRole('combobox',{name:'任务关联患者'});
  const upload=page.locator('.patients-toolbar').getByRole('button',{name:'上传资料建档',exact:true});
  // The composer mounts before the saved medical task type is restored.
  // Wait for an actual intake entry instead of branching on the empty shell.
  await picker.or(upload).first().waitFor();
  if (await picker.isVisible()) await picker.selectOption('__new');
  else await upload.click();
}
