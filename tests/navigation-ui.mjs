export async function openTool(page, name) {
  await page.getByRole('navigation', {name:'资料与工具', exact:true}).getByRole('button').click();
  await page.getByRole('link').filter({has:page.getByRole('heading',{name,exact:true})}).click();
}
export async function openPatient(page, name) {
  await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
  await page.locator('.patient-card').filter({hasText:name}).click();
}
export async function openIntake(page) {
  await page.locator('.hub-composer, .patients-view').first().waitFor();
  const picker=page.getByRole('combobox',{name:'任务关联患者'});
  if (await picker.count()) await picker.selectOption('__new');
  else await page.locator('.patients-toolbar').getByRole('button',{name:'上传资料建档',exact:true}).click();
}
